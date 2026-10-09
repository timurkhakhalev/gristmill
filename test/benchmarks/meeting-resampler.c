/* Experimental offline resampler. Not part of the application or its package. */
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

typedef struct { int64_t first, last, start, end; } Range;
static void require(int ok, const char *message) {
    if (!ok) { fprintf(stderr, "%s (errno=%d)\n", message, errno); exit(1); }
}

int main(int argc, char **argv) {
    require(argc == 5, "usage: resampler input.f32 mapping.txt output.f32 extent");
    char *endptr;
    const int64_t extent = strtoll(argv[4], &endptr, 10);
    require(!*endptr && extent > 0 && extent <= INT64_C(24000) * 8000, "invalid extent");
    FILE *input = fopen(argv[1], "rb"), *mapping = fopen(argv[2], "r");
    require(input && mapping, "open input");
    Range ranges[4096];
    int count = 0;
    long long first, last, start, end;
    int parsed;
    while ((parsed = fscanf(mapping, "%lld %lld %lld %lld", &first, &last, &start, &end)) == 4) {
        require(count < 4096, "too many ranges");
        require(first >= 0 && last > first && start >= 0 && end > start && end <= extent, "invalid range");
        require(last - first <= 24000 * 60 && end - start <= 24000 * 61, "range too large");
        require(count ? first == ranges[count-1].last && start >= ranges[count-1].end : first == 0, "unsupported source gap or output overlap");
        ranges[count++] = (Range){first, last, start, end};
    }
    require(parsed == EOF && count > 0, "malformed mapping");
    fclose(mapping);
    require(fseeko(input, 0, SEEK_END) == 0 && ftello(input) == ranges[count-1].last * 4, "input length mismatch");
    rewind(input);
    FILE *output = fopen(argv[3], "w+b");
    require(output != NULL, "open output");
    require(ftruncate(fileno(output), extent * 4) == 0, "size output");
    float in[4096], out[16384];
    int resets = 0, maxResidual = 0;
    int64_t converted = 0;
    for (int group = 0; group < count;) {
        int limit = group + 1;
        while (limit < count && ranges[limit].start == ranges[limit-1].end) limit++;
        const int64_t expected = ranges[limit-1].end - ranges[group].start;
        int64_t produced = 0;
        SwrContext *swr = NULL;
        AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
        require(swr_alloc_set_opts2(&swr, &mono, AV_SAMPLE_FMT_FLT, 24000,
                                   &mono, AV_SAMPLE_FMT_FLT, 24000, 0, NULL) >= 0, "allocate resampler");
        require(av_opt_set_int(swr, "flags", SWR_FLAG_RESAMPLE, 0) >= 0 && swr_init(swr) >= 0, "initialize resampler");
        require(fseeko(output, ranges[group].start * 4, SEEK_SET) == 0, "seek output");
        resets++;
        for (int i = group; i <= limit; i++) {
            int64_t remaining = i < limit ? ranges[i].last - ranges[i].first : 0;
            if (i < limit) {
                const int distance = (int)(ranges[i].end - ranges[i].start);
                require(swr_set_compensation(swr, distance - (int)remaining, distance) >= 0, "set compensation");
            }
            do {
                const int n = remaining > 4096 ? 4096 : (int)remaining;
                if (i < limit) require(fread(in, 4, n, input) == (size_t)n, "read samples");
                const uint8_t *source[] = {(const uint8_t *)in};
                uint8_t *destination[] = {(uint8_t *)out};
                const int got = swr_convert(swr, destination, 16384, i < limit ? source : NULL, n);
                require(got >= 0, "convert samples");
                const int writeCount = produced >= expected ? 0 : (int)fmin(got, expected - produced);
                require(fwrite(out, 4, writeCount, output) == (size_t)writeCount, "write samples");
                produced += got;
                remaining -= n;
                if (i == limit && got == 0) break;
            } while (remaining > 0 || i == limit);
        }
        /* Flush can round up by a sample. Never silently conceal a larger mismatch. */
        const int residual = (int)llabs(produced - expected);
        if (residual > maxResidual) maxResidual = residual;
        require(residual <= 2, "resampler endpoint differs by more than two samples");
        converted += produced;
        swr_free(&swr);
        group = limit;
    }
    require(fclose(input) == 0 && fclose(output) == 0, "close audio files");
    struct rusage usage;
    require(getrusage(RUSAGE_SELF, &usage) == 0, "read resource usage");
    printf("{\"ranges\":%d,\"continuousRuns\":%d,\"convertedFrames\":%lld,\"maxEndpointRoundingFrames\":%d,\"cpuSeconds\":%.6f,\"maxRssBytes\":%ld}\n",
           count, resets, (long long)converted, maxResidual,
           usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6 + usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6,
           usage.ru_maxrss);
    return 0;
}
