import { englishResource } from "../resources";
import { zhHansResource } from "./zh-Hans";
import { zhHantResource } from "./zh-Hant";
import { japaneseResource } from "./ja";
import { koreanResource } from "./ko";

export const resources = {
  ...englishResource,
  ...zhHansResource,
  ...zhHantResource,
  ...japaneseResource,
  ...koreanResource,
} as const;
export type TranslationResources = typeof resources;
