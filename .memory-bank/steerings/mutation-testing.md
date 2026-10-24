# Mutation testing

Mutation targets are the explicit allowlist in `scripts/mutation-targets.mts`.
Each entry binds one target ID to its production scope, focused tests, direct
dependencies and artifact directory. `stryker.config.mts` resolves the target
from the `MUTATION_TARGET` value that the runner exports after validating the
CLI selection, then derives the Stryker command, mutate scope, reporters and
limits from it. There is no whole-repository default: without a registered
target, Stryker fails at config load.

`pnpm mutation --list` prints the registered target IDs. Unknown targets and
modes, missing scope files and unsafe paths (absolute, escaping or
non-normalized paths, artifact directories outside `reports/mutation/`) fail
before Stryker starts. Reports stay separate per target under
`reports/mutation/<target-slug>/`.

The command runner uses the existing canonical `pnpm test` path and `node:test`.
It does not add another test framework. Coverage analysis is off: every mutant
runs the focused test file. This runner cannot distinguish uncovered mutations
from other survivors. A dry run checks the instrumented baseline and has no
mutation score.

```sh
pnpm mutation --list
pnpm mutation --target recording:resampler-mapping --mode dry-run
pnpm mutation --target recording:resampler-mapping --mode full
```

Every registered target runs through the same command with its own ID; `--list`
prints the current allowlist. A new registry entry changes the shared runner
inputs, so existing target fingerprints change and their next run needs a fresh
dry run on the new definition.

Run dry first for a new target or after changes to scope, focused tests, runner,
config, dependencies, toolchain or provider. A matching successful dry/full
artifact permits a direct full run. Compare its fingerprint and runtime inputs;
the command does not enforce historical validation. Keep one run at a time.

The worker limit is one. The runner stops dry runs after five minutes and full
runs after twenty minutes. The dry-run baseline has a four-minute Stryker limit.
The score is diagnostic; there is no blocking score until a reviewed baseline
exists. Do not change production code or tests to improve scores in a setup task.

## Cloud Run

Build the source image with Node 24 and pnpm 10.19.0. The Dockerfile's adjacent
ignore file restricts the build context to source and test inputs. It excludes
Git history, local profiles, credentials, environment files and generated reports.
Never place tokens or private infrastructure identifiers in committed files.
The public source needs no GitHub token. The container uses its Cloud Run
identity to upload reports; it does not contain a service-account key.

Set these operator-local environment variables: `GCP_PROJECT`, `GCP_REGION`,
`MUTATION_IMAGE` (an Artifact Registry image tag), `MUTATION_JOB`,
`MUTATION_SERVICE_ACCOUNT`, `REPORTS_BUCKET` (without `gs://`) and `REPORTS_PREFIX`.
Use an existing identity with object-create access to the report bucket, or
obtain explicit approval before changing IAM. Keep the bucket private.

```sh
docker build --platform linux/amd64 -f scripts/mutation-cloud/Dockerfile -t "$MUTATION_IMAGE" .
docker push "$MUTATION_IMAGE"
gcloud run jobs deploy "$MUTATION_JOB" \
  --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --image "$MUTATION_IMAGE" --service-account "$MUTATION_SERVICE_ACCOUNT" \
  --cpu 2 --memory 4Gi --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 1800s \
  --set-env-vars "MUTATION_TARGET=recording:resampler-mapping,MUTATION_MODE=dry-run,MUTATION_COMMIT=$(git rev-parse HEAD),MUTATION_DIRTY=false,REPORTS_BUCKET=$REPORTS_BUCKET,REPORTS_PREFIX=$REPORTS_PREFIX"
gcloud run jobs execute "$MUTATION_JOB" --project "$GCP_PROJECT" --region "$GCP_REGION" --wait
```

Build from a committed checkout for a reproducible run. For an explicit working
tree snapshot, set `MUTATION_DIRTY=true` and retain its fingerprint. The commit
field then names the base commit, not a committed version of the configuration.
Pin the deployed image digest when comparing evidence. Do not add push, pull
request or scheduled triggers. Cloud billing/free-tier headroom is shared with
other jobs; a timeout limits one execution but does not enforce a monthly budget.

## Evidence

Reports are ignored under `reports/mutation/<target-slug>/` (the pilot:
`reports/mutation/recording/resampler-mapping/`). `metadata.json` records mode,
base commit, dirty state, provider, runtime, fingerprint and its input file
list, timing, limits, exit status and distinct mutation outcomes.
A dry run has `outcomeCounts: null`; JSON and HTML mutation reports require full
mode. The entrypoint attempts report upload on command failure and preserves a
nonzero command status. An upload failure also fails the job.

Cloud objects use `$REPORTS_PREFIX/$CLOUD_RUN_EXECUTION/reports/mutation/` so
separate executions do not overwrite each other. Download only the selected
execution. Generated reports, logs, execution IDs and private GCP identifiers
must stay out of Git. Full mode is a separate manual operator action.
