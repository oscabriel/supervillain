import { placeholder as corePlaceholder } from "@supervillain/core";

/** Proves the host consumes the core package through its built entry point. */
export const hostCorePlaceholder: typeof corePlaceholder = corePlaceholder;
