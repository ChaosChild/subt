// Provider registry — the single list core iterates under Promise.allSettled.

import type { ProviderModule } from "../core.ts";
import claude from "./claude.ts";
import glm from "./glm.ts";
import alibaba from "./alibaba.ts";
import google from "./google.ts";
import opencode from "./opencode.ts";
import openrouter from "./openrouter.ts";

export const allProviders: ProviderModule[] = [claude, glm, alibaba, google, opencode, openrouter];
