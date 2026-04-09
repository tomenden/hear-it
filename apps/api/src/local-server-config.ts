const DEFAULT_SUPABASE_URL = "https://qnvsdeshcxjnzlgrrhxd.supabase.co";

export interface LocalServerConfig {
  supabaseUrl?: string;
  supabaseJwtSecret?: string;
  allowJwtSecretFallback: boolean;
}

export function resolveLocalServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): LocalServerConfig {
  const explicitSupabaseUrl = env.SUPABASE_URL?.trim() || undefined;
  const supabaseJwtSecret = env.SUPABASE_JWT_SECRET?.trim() || undefined;

  if (explicitSupabaseUrl) {
    return {
      supabaseUrl: explicitSupabaseUrl,
      supabaseJwtSecret,
      allowJwtSecretFallback: false,
    };
  }

  if (supabaseJwtSecret) {
    return {
      supabaseUrl: DEFAULT_SUPABASE_URL,
      supabaseJwtSecret,
      allowJwtSecretFallback: true,
    };
  }

  return {
    supabaseUrl: undefined,
    supabaseJwtSecret: undefined,
    allowJwtSecretFallback: false,
  };
}
