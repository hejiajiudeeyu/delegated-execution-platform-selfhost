import {
  ensureOpsDirectories,
  getOpsConfigFile,
  getOpsEnvFile,
  getOpsSecretsFile,
  readEnvFile,
  readJsonFile,
  secretStoreExists,
  unlockSecretStore,
  updateEnvFile,
  writeJsonFile,
  writeSecretValues
} from "@delexec/runtime-utils";

export const OPS_SECRET_KEYS = Object.freeze({
  caller_api_key: "caller_api_key",
  responder_platform_api_key: "responder_platform_api_key",
  transport_emailengine_access_token: "transport_emailengine_access_token",
  transport_gmail_client_secret: "transport_gmail_client_secret",
  transport_gmail_refresh_token: "transport_gmail_refresh_token",
  platform_admin_api_key: "platform_admin_api_key"
});

function normalizedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function createDefaultGatewayConfig(env = {}) {
  const baseUrl = env.PLATFORM_API_BASE_URL || process.env.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080";
  return {
    platform: {
      base_url: baseUrl
    },
    platform_console: {
      base_url: baseUrl,
      admin_api_key: null
    },
    caller: {
      api_key: null,
      api_key_configured: Boolean(env.CALLER_PLATFORM_API_KEY || env.PLATFORM_API_KEY || process.env.CALLER_PLATFORM_API_KEY || process.env.PLATFORM_API_KEY)
    }
  };
}

export function ensureOpsState() {
  ensureOpsDirectories();
  const envFile = getOpsEnvFile();
  const env = readEnvFile(envFile);
  const secretsFile = getOpsSecretsFile();
  const opsConfigFile = getOpsConfigFile();
  const config = readJsonFile(opsConfigFile, createDefaultGatewayConfig(env));

  config.platform ||= { base_url: env.PLATFORM_API_BASE_URL || process.env.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080" };
  config.platform_console ||= { base_url: config.platform.base_url, admin_api_key: null };
  config.caller ||= { api_key: null, api_key_configured: false };
  config.caller.api_key = normalizedString(config.caller.api_key);
  config.caller.api_key_configured = Boolean(
    config.caller.api_key ||
      env.CALLER_PLATFORM_API_KEY ||
      env.PLATFORM_API_KEY ||
      process.env.CALLER_PLATFORM_API_KEY ||
      process.env.PLATFORM_API_KEY
  );

  return { envFile, opsConfigFile, secretsFile, env, config };
}

export function hasEncryptedSecretStore() {
  return secretStoreExists(getOpsSecretsFile());
}

export function unlockOpsSecrets(passphrase) {
  return unlockSecretStore(getOpsSecretsFile(), passphrase).secrets;
}

export function writeOpsSecrets(passphrase, updates) {
  return writeSecretValues(getOpsSecretsFile(), passphrase, updates);
}

export function readResolvedOpsSecrets(state, unlockedSecrets = null) {
  const env = state?.env || {};
  const encrypted = unlockedSecrets || {};
  return {
    caller_api_key: normalizedString(encrypted[OPS_SECRET_KEYS.caller_api_key]) || normalizedString(env.CALLER_PLATFORM_API_KEY) || normalizedString(env.PLATFORM_API_KEY),
    responder_platform_api_key:
      normalizedString(encrypted[OPS_SECRET_KEYS.responder_platform_api_key]) || normalizedString(env.RESPONDER_PLATFORM_API_KEY),
    transport: {
      emailengine: {
        access_token:
          normalizedString(encrypted[OPS_SECRET_KEYS.transport_emailengine_access_token]) ||
          normalizedString(env.TRANSPORT_EMAILENGINE_ACCESS_TOKEN)
      },
      gmail: {
        client_secret:
          normalizedString(encrypted[OPS_SECRET_KEYS.transport_gmail_client_secret]) ||
          normalizedString(env.TRANSPORT_GMAIL_CLIENT_SECRET),
        refresh_token:
          normalizedString(encrypted[OPS_SECRET_KEYS.transport_gmail_refresh_token]) ||
          normalizedString(env.TRANSPORT_GMAIL_REFRESH_TOKEN)
      }
    },
    platform_admin_api_key:
      normalizedString(encrypted[OPS_SECRET_KEYS.platform_admin_api_key]) ||
      normalizedString(env.PLATFORM_ADMIN_API_KEY) ||
      normalizedString(state?.config?.platform_console?.admin_api_key)
  };
}

export function scrubLegacySecrets(state) {
  if (!state?.config || !state?.envFile) {
    return state;
  }
  state.config.caller ||= {};
  state.config.caller.api_key = null;
  state.config.caller.api_key_configured = true;
  state.config.platform_console ||= {};
  state.config.platform_console.admin_api_key = null;
  writeJsonFile(state.opsConfigFile, state.config);
  state.env = updateEnvFile(
    state.envFile,
    {
      CALLER_PLATFORM_API_KEY: null,
      PLATFORM_API_KEY: null,
      RESPONDER_PLATFORM_API_KEY: null,
      PLATFORM_ADMIN_API_KEY: null,
      TRANSPORT_EMAILENGINE_ACCESS_TOKEN: null,
      TRANSPORT_GMAIL_CLIENT_SECRET: null,
      TRANSPORT_GMAIL_REFRESH_TOKEN: null
    },
    { removeNull: true }
  );
  return state;
}

export function saveOpsState({ envFile, opsConfigFile, env, config }) {
  const encryptedStoreConfigured = hasEncryptedSecretStore();
  config.caller ||= {};
  config.caller.api_key = null;
  config.caller.api_key_configured = Boolean(
    config.caller.api_key_configured ||
      env.CALLER_PLATFORM_API_KEY ||
      env.PLATFORM_API_KEY ||
      config.caller.api_key
  );
  config.platform_console ||= {};
  config.platform_console.admin_api_key = null;
  writeJsonFile(opsConfigFile, config);
  return updateEnvFile(
    envFile,
    {
      PLATFORM_API_BASE_URL: config.platform_console?.base_url || config.platform?.base_url || env.PLATFORM_API_BASE_URL || null,
      CALLER_PLATFORM_API_KEY: encryptedStoreConfigured ? null : normalizedString(env.CALLER_PLATFORM_API_KEY) || normalizedString(env.PLATFORM_API_KEY),
      PLATFORM_API_KEY: encryptedStoreConfigured ? null : normalizedString(env.PLATFORM_API_KEY) || normalizedString(env.CALLER_PLATFORM_API_KEY),
      RESPONDER_PLATFORM_API_KEY: encryptedStoreConfigured ? null : normalizedString(env.RESPONDER_PLATFORM_API_KEY),
      PLATFORM_ADMIN_API_KEY: encryptedStoreConfigured
        ? null
        : normalizedString(env.PLATFORM_ADMIN_API_KEY) || normalizedString(config.platform_console?.admin_api_key),
      TRANSPORT_EMAILENGINE_ACCESS_TOKEN: encryptedStoreConfigured ? null : normalizedString(env.TRANSPORT_EMAILENGINE_ACCESS_TOKEN),
      TRANSPORT_GMAIL_CLIENT_SECRET: encryptedStoreConfigured ? null : normalizedString(env.TRANSPORT_GMAIL_CLIENT_SECRET),
      TRANSPORT_GMAIL_REFRESH_TOKEN: encryptedStoreConfigured ? null : normalizedString(env.TRANSPORT_GMAIL_REFRESH_TOKEN)
    },
    { removeNull: true }
  );
}
