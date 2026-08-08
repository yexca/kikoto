export const WORK_CODE_PATTERN = /^(?:RJ|BJ|VJ|CC)\d{5,8}$/i;
export const WORK_CODE_PATH_PATTERN = /^\/((?:RJ|BJ|VJ|CC)\d{5,8})\/?$/i;

export function isWorkCode(value: string) {
  return WORK_CODE_PATTERN.test(value);
}

export function isWorkCodePath(value: string) {
  return WORK_CODE_PATH_PATTERN.test(value);
}
