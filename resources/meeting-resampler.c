/* Private 48 kHz decoded float -> 24 kHz timeline preparation boundary.
   Mapping coordinates and inputFrames argv remain in original 24 kHz frame units.
   Output publication belongs to the caller. */
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Stable exit categories: mapping, decoded input, I/O, resampler. */
enum { MAPPING = 2, INPUT = 3, IO = 4, RESAMPLER = 5, BLOCK = 4096, OUTPUT_BLOCK = 16384, EDGE = 128 };
typedef struct { int64_t first, last, start, end; int reset; } Range;
static void check(int ok, int category, const char *message) {
    if (!ok) { fprintf(stderr, "meeting-resampler: %s (errno=%d)\n", message, errno); exit(category); }
}
static int64_t number(const char **cursor) {
    while (isspace((unsigned char)**cursor)) (*cursor)++;
    check(isdigit((unsigned char)**cursor), MAPPING, "invalid integer");
    errno = 0;
    char *end;
    int64_t value = strtoll(*cursor, &end, 10);
    check(errno != ERANGE && value >= 0 && (isspace((unsigned char)*end) || !*end), MAPPING, "integer overflow or malformed field");
    *cursor = end;
    return value;
}
static int row(FILE *file, Range *range) {
    char line[256];
    if (!fgets(line, sizeof(line), file)) { check(!ferror(file), IO, "read mapping"); return 0; }
    check(strchr(line, '\n') != NULL, MAPPING, "truncated or oversized mapping line");
    const char *cursor = line;
    range->first = number(&cursor); range->last = number(&cursor);
    range->start = number(&cursor); range->end = number(&cursor);
    int64_t reset = number(&cursor);
    while (isspace((unsigned char)*cursor)) cursor++;
    check(!*cursor && reset <= 1, MAPPING, "extra fields or invalid reset");
    range->reset = (int)reset;
    return 1;
}
static void add(FILE *output, int64_t position, float *samples, int count) {
    float existing[OUTPUT_BLOCK];
    size_t bytes = (size_t)count * sizeof(float);
    check(pread(fileno(output), existing, bytes, position * 4) == (ssize_t)bytes, IO, "read overlap");
    for (int i = 0; i < count; i++) {
        samples[i] += existing[i];
        check(isfinite(samples[i]), INPUT, "nonfinite mixed sample");
    }
    check(pwrite(fileno(output), samples, bytes, position * 4) == (ssize_t)bytes, IO, "write timeline");
}
static int convert(SwrContext *swr, FILE *output, const float *input, int count,
                   int64_t start, int64_t *produced, int64_t expected, int terminal) {
    float samples[OUTPUT_BLOCK];
    const uint8_t *source[] = {(const uint8_t *)input};
    uint8_t *destination[] = {(uint8_t *)samples};
    int got = swr_convert(swr, destination, OUTPUT_BLOCK, input ? source : NULL, count);
    check(got >= 0, RESAMPLER, "convert samples");
    check(terminal || *produced + got <= expected, RESAMPLER, "nonterminal endpoint overrun");
    int write_count = *produced >= expected ? 0 : (int)fmin(got, expected - *produced);
    if (write_count) add(output, start + *produced, samples, write_count);
    *produced += got;
    return got;
}
static void finish(SwrContext **swr, FILE *output, int64_t start, int64_t *produced,
                   int64_t expected, int *max_rounding, const float *tail, int64_t consumed) {
    /* The default 32-tap downsampler needs 67 input samples to initialize its
       reflected left boundary. Supply reflected right context for every run,
       only after its complete real input has been read and validated. */
    float reflected[EDGE];
    int size = consumed < EDGE ? (int)consumed : EDGE;
    for (int i = 0; i < EDGE; i++) {
        int phase = i % (size * 2);
        int index = phase < size ? size - 1 - phase : phase - size;
        reflected[i] = tail[(consumed - size + index) % EDGE];
    }
    convert(*swr, output, reflected, EDGE, start, produced, expected, 1);
    while (convert(*swr, output, NULL, 0, start, produced, expected, 1)) {}
    /* Boundary context is not source coverage or endpoint rounding. */
    int64_t residual = llabs(*produced - EDGE / 2 - expected);
    check(*produced >= expected, RESAMPLER, "missing source endpoint samples");
    check(residual <= 2, RESAMPLER, "endpoint differs by more than two samples");
    if (residual > *max_rounding) *max_rounding = (int)residual;
    swr_free(swr);
}
int main(int argc, char **argv) {
    check(argc == 7, MAPPING, "usage: input.f32 mapping output.f32 extent inputFrames create|add");
    const char *cursor = argv[4];
    int64_t extent = number(&cursor);
    check(!*cursor && extent > 0 && extent <= INT64_MAX / 4, MAPPING, "invalid extent");
    cursor = argv[5];
    int64_t input_frames = number(&cursor);
    check(!*cursor && input_frames > 0 && input_frames <= INT64_MAX / 8, MAPPING, "invalid input length");
    int create = !strcmp(argv[6], "create");
    check(create || !strcmp(argv[6], "add"), MAPPING, "invalid output mode");
    FILE *mapping = fopen(argv[2], "r");
    check(mapping != NULL, IO, "open mapping");
    Range current, previous = {0};
    int64_t count = 0;
    while (row(mapping, &current)) {
        check(current.first == previous.last && current.last > current.first && current.last <= input_frames &&
              current.start < current.end && current.end <= extent, MAPPING, "inconsistent coverage");
        int64_t n = current.last - current.first, target = current.end - current.start;
        /* Untouched short affine ranges retain their one-frame coordinate rounding. */
        check(fabsl((long double)target - n) <= (long double)n * 0.001L + 1.0L,
              MAPPING, "unsupported alignment rate");
        check(count ? current.reset || current.start == previous.end : current.reset,
              MAPPING, "invalid continuous run");
        if (count && !current.reset) {
            int64_t prior_n = previous.last - previous.first;
            int64_t prior_target = previous.end - previous.start;
            check((long double)prior_target / prior_n >= 0.999L &&
                  (long double)prior_target / prior_n <= 1.001L,
                  MAPPING, "reconciled rate exceeds bounds");
        }
        previous = current;
        count++;
    }
    check(count > 0 && previous.last == input_frames, MAPPING, "incomplete input coverage");
    check(fseek(mapping, 0, SEEK_SET) == 0, IO, "rewind mapping");
    FILE *input = fopen(argv[1], "rb");
    check(input != NULL, IO, "open decoded input");
    struct stat stats;
    check(fstat(fileno(input), &stats) == 0, IO, "inspect decoded input");
    check(S_ISREG(stats.st_mode) && stats.st_size == input_frames * 8, INPUT, "decoded input length mismatch");
    FILE *output = fopen(argv[3], create ? "w+bx" : "r+b");
    check(output != NULL, IO, "open output");
    if (create) check(ftruncate(fileno(output), extent * 4) == 0, IO, "size output");
    check(fstat(fileno(output), &stats) == 0 && stats.st_size == extent * 4, IO, "output extent mismatch");
    SwrContext *swr = NULL;
    int64_t start = 0, produced = 0, expected = 0, runs = 0;
    int max_rounding = 0;
    float samples[BLOCK], tail[EDGE];
    int64_t consumed = 0;
    while (row(mapping, &current)) {
        if (current.reset) {
            if (swr) finish(&swr, output, start, &produced, expected, &max_rounding, tail, consumed);
            AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
            check(swr_alloc_set_opts2(&swr, &mono, AV_SAMPLE_FMT_FLT, 24000,
                                     &mono, AV_SAMPLE_FMT_FLT, 48000, 0, NULL) >= 0, RESAMPLER, "allocate resampler");
            check(av_opt_set_int(swr, "flags", SWR_FLAG_RESAMPLE, 0) >= 0 && swr_init(swr) >= 0, RESAMPLER, "initialize resampler");
            start = current.start; produced = 0; consumed = 0; runs++;
        }
        expected = current.end - start;
        int64_t remaining = (current.last - current.first) * 2;
        while (remaining) {
            /* Include buffered delay and emitted samples in the endpoint budget.
               Split only the compensation distance required by libswresample's int API. */
            int64_t delay = swr_get_delay(swr, 24000);
            int64_t distance = expected - produced;
            int64_t delta = distance - delay - remaining / 2;
            int64_t window = distance > INT_MAX ? INT_MAX : distance;
            int64_t correction = distance > INT_MAX ? llround((long double)delta * window / distance) : delta;
            check(window > 0 && correction >= INT_MIN && correction <= INT_MAX, RESAMPLER, "invalid compensation budget");
            check(swr_set_compensation(swr, (int)correction, (int)window) >= 0, RESAMPLER, "set compensation");
            /* The same compensation stays active through this range (or API window). */
            int64_t batch = remaining;
            if (distance > INT_MAX && batch > INT_MAX / 2) batch = (INT_MAX / 2) & ~INT64_C(1);
            while (batch) {
                int n = batch > BLOCK ? BLOCK : (int)batch;
                size_t read_count = fread(samples, sizeof(float), (size_t)n, input);
                check(!ferror(input), IO, "read decoded input");
                check(read_count == (size_t)n, INPUT, "truncated decoded input");
                for (int i = 0; i < n; i++) {
                    check(isfinite(samples[i]), INPUT, "nonfinite decoded sample");
                    tail[consumed++ % EDGE] = samples[i];
                }
                convert(swr, output, samples, n, start, &produced, expected, 0);
                remaining -= n; batch -= n;
            }
        }
    }
    finish(&swr, output, start, &produced, expected, &max_rounding, tail, consumed);
    check(fclose(input) == 0 && fclose(mapping) == 0 && fclose(output) == 0, IO, "close files");
    printf("{\"ranges\":%" PRId64 ",\"continuousRuns\":%" PRId64 ",\"maxEndpointRoundingFrames\":%d}\n", count, runs, max_rounding);
    return 0;
}
