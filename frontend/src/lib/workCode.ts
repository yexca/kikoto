export const WORK_CODE_PATTERN = /^(?:RJ|BJ|VJ|CC|KT)\d{5,8}$/i;
export const WORK_CODE_PATH_PATTERN = /^\/((?:RJ|BJ|VJ|CC|KT)\d{5,8})\/?$/i;

export function isWorkCode(value: string) {
  return WORK_CODE_PATTERN.test(value);
}

/** Whether a code is a custom work's code, which no provider or remote source knows. */
export function isCustomWorkCode(value: string) {
  return /^KT\d/i.test(value.trim());
}

export function isWorkCodePath(value: string) {
  return WORK_CODE_PATH_PATTERN.test(value);
}
