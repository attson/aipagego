import {
  resolveInjectionPolicy,
  type ResolvedInjectionPolicy
} from "@aipagego/shared";
import type { InjectionMode, LlmSettings, SiteInjectionRule } from "@aipagego/shared/types";

export const SETTINGS_KEY = "aipagego.llm";
export const DEFAULT_INJECTION_MODE: InjectionMode = "diagnostic";
export const DEFAULT_ASSISTANT_ENABLED = true;

type PolicySettings = Pick<
  LlmSettings,
  "defaultInjectionMode" | "defaultAssistantEnabled" | "siteInjectionRules"
>;

export function policySettingsFrom(raw: unknown): PolicySettings {
  const value = raw && typeof raw === "object" ? raw as Partial<LlmSettings> : {};
  return {
    defaultInjectionMode: isInjectionMode(value.defaultInjectionMode)
      ? value.defaultInjectionMode
      : DEFAULT_INJECTION_MODE,
    defaultAssistantEnabled: value.defaultAssistantEnabled !== false,
    siteInjectionRules: Array.isArray(value.siteInjectionRules)
      ? value.siteInjectionRules.filter(isSiteRule)
      : []
  };
}

export function resolvePolicyForHostname(hostname: string, raw: unknown): ResolvedInjectionPolicy {
  const settings = policySettingsFrom(raw);
  return resolveInjectionPolicy({ hostname, ...settings, rules: settings.siteInjectionRules });
}

export async function readPolicyForHostname(hostname: string): Promise<ResolvedInjectionPolicy> {
  let stored: unknown;
  try {
    stored = (await chrome.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY];
  } catch {
    stored = undefined;
  }
  return resolvePolicyForHostname(hostname, stored);
}

export async function readPolicyForTab(tabId: number): Promise<ResolvedInjectionPolicy> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) return { injectionMode: "disabled", assistantEnabled: false };
  let hostname: string;
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    return { injectionMode: "disabled", assistantEnabled: false };
  }
  return readPolicyForHostname(hostname);
}

function isInjectionMode(value: unknown): value is InjectionMode {
  return value === "disabled" || value === "read" || value === "operate" || value === "diagnostic";
}

function isSiteRule(value: unknown): value is SiteInjectionRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<SiteInjectionRule>;
  return typeof rule.pattern === "string" &&
    (rule.injectionMode === "inherit" || isInjectionMode(rule.injectionMode)) &&
    (rule.assistant === "inherit" || rule.assistant === "enabled" || rule.assistant === "disabled");
}
