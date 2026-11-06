export type ErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION_ERROR" | "INVALID_STATE"
  | "CONFLICT" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "INTERNAL";

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: { nextCursor?: string | null; hasNext?: boolean };
}

export interface ApiError {
  success: false;
  error: { code: ErrorCode; message: string; details?: { field: string; message: string }[] };
}

export const ok = <T>(data: T, meta?: ApiSuccess<T>["meta"]): ApiSuccess<T> =>
  meta ? { success: true, data, meta } : { success: true, data };

export const fail = (code: ErrorCode, message: string, details?: ApiError["error"]["details"]): ApiError => ({
  success: false,
  error: details ? { code, message, details } : { code, message },
});
