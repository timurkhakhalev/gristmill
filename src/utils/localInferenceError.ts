/**
 * Turns a failed local-inference IPC result into an Error the UI can render.
 *
 * The main process reports a machine-readable `code` and `details`; the
 * translation keys live here, on the renderer side, so both surfaces that show
 * these failures — the notes toast and the dictation cleanup toast — get the
 * same wording for free.
 *
 * Before #2142 the raw llama.cpp 400 body was shown to the user verbatim.
 */

// The detail fields this renderer reads. The main process may attach more; the
// renderer only ever shows the model name and the two token counts.
export interface LocalInferenceFailureDetails {
  modelName?: string;
  neededTokens?: number;
  maxContextTokens?: number;
  error?: string;
}

export interface LocalInferenceFailure {
  error?: string;
  code?: string;
  details?: LocalInferenceFailureDetails | null;
}

export interface LocalInferenceError extends Error {
  code?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
}

function asPositiveInteger(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function detailString(value: string | undefined): string {
  return value ?? "";
}

function contextTooLarge(
  details: LocalInferenceFailureDetails
): Pick<LocalInferenceError, "messageKey" | "messageParams"> {
  const model = detailString(details.modelName);
  const needed = asPositiveInteger(details.neededTokens);
  const max = asPositiveInteger(details.maxContextTokens);

  if (needed === null || max === null) {
    return {
      messageKey: "models.errors.contextTooLargeGeneric",
      messageParams: { model },
    };
  }

  return {
    messageKey: "models.errors.contextTooLarge",
    messageParams: { model, needed, max },
  };
}

export function buildLocalInferenceError(result: LocalInferenceFailure): LocalInferenceError {
  const error: LocalInferenceError = new Error(result.error || "Local inference failed");

  if (result.code) error.code = result.code;

  const details = result.details ?? {};

  if (result.code === "CONTEXT_TOO_LARGE") {
    Object.assign(error, contextTooLarge(details));
  } else if (result.code === "LOCAL_SERVER_UNAVAILABLE") {
    // The llama.cpp startup dump stays in the main-process log; only the model
    // name crosses, so there is nothing here that could reach the user raw.
    error.messageKey = "models.errors.localServerUnavailable";
    error.messageParams = { model: detailString(details.modelName) };
  }

  return error;
}
