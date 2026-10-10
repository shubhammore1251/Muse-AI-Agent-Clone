import { Tool, ToolConnectionStatus, UserToolConnection } from "@/types";
import { Composio } from "@composio/core";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = ws;
}

const KNOWN_AUTH_CONFIGS: Record<string, string> = {
  gmail: "ac_GRwoF65CzaPI",
  googlecalendar: "ac_Nd2GFWWm3R2o",
  notion: "ac_dyGWdU98TCSs",
  slack: "ac_0RV0dNTlTlbB",
  googlesheets: "ac_owuc7RjPsZVY",
  outlook: "ac_3xlHBD4sAC35",
  trello: "ac_cUrZgDPrPOIi",
  jira: "ac_W8UkzDnBYdPz",
  calcom: "ac_xloe2MCIaqsY",
  calendly: "ac_hDTqXRLy0k87",
  google_meet: "ac_qTcJN0MUIWyb",
  zoom: "ac_NC_rJ8N76rkd",
  microsoftteams: "ac_7Ln0XDkTbVmN",
};

export function getComposioClient(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is not defined in environment variables.",
    );
  }
  return new Composio({ apiKey });
}

export function getSupabaseAdminClient(userToken?: string) {
  const supabaseUrl =
    process.env.EXPO_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://placeholder.supabase.co";
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.EXPO_PUBLIC_SUPABASE_KEY ||
    "placeholder-key";
  const options: any = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  };

  if (userToken) {
    options.global = {
      headers: {
        Authorization: `Bearer ${userToken.replace(/^Bearer\s+/i, "")}`,
      },
    };
  }

  return createClient(supabaseUrl, supabaseKey, options);
}

// export async function validateUserFromRequest(
//   req: Request,
// ): Promise<{ userId: string; userEmail?: string; token?: string }> {
//   const supabaseAdmin = getSupabaseAdminClient();
//   const authHeader =
//     req.headers.get("Authorization") || req.headers.get("authorization");

//   if (authHeader?.startsWith("Bearer ")) {
//     const token = authHeader.substring(7).trim();
//     const { data, error } = await supabaseAdmin.auth.getUser(token);
//     if (!error && data?.user) {
//       return {
//         userId: data.user.id,
//         userEmail: data.user.email,
//         token,
//       };
//     }
//   }

//   if (
//     bodyUserId &&
//     typeof bodyUserId === "string" &&
//     bodyUserId.trim().length > 0
//   ) {
//     return { userId: bodyUserId.trim() };
//   }

//   throw new Error(
//     "Unauthorized: Valid authorization token or userId is required.",
//   );
// }

export async function validateUserFromRequest(
  req: Request,
  bodyUserId?: string,
): Promise<{ userId: string; userEmail?: string; token?: string }> {
  const supabaseAdmin = getSupabaseAdminClient();
  const authHeader =
    req.headers.get("Authorization") || req.headers.get("authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && data?.user) {
      return {
        userId: data.user.id,
        userEmail: data.user.email,
        token,
      };
    }
  }

  if (
    bodyUserId &&
    typeof bodyUserId === "string" &&
    bodyUserId.trim().length > 0
  ) {
    return { userId: bodyUserId.trim() };
  }

  throw new Error(
    "Unauthorized: Valid authorization token or userId is required.",
  );
}

function accountMatchesTool(account: any, tool: any) {
  const accountToolkit = account?.toolkit?.slug?.toLowerCase();
  const toolSlug = tool?.slug?.toLowerCase();
  const toolkitSlug = tool?.toolkit_slug?.toLowerCase();

  return (
    account?.authConfig?.id === tool?.composio_auth_config_id ||
    accountToolkit === toolkitSlug ||
    accountToolkit === toolSlug
  );
}

async function findActiveConnectedAccountForTool(
  composio: Composio,
  userId: string,
  tool: any,
) {
  const activeAccounts = await composio.connectedAccounts.list({
    userIds: [userId],
    statuses: ["ACTIVE" as any],
  });

  return (
    activeAccounts?.items?.find((account: any) =>
      accountMatchesTool(account, tool),
    ) || null
  );
}

async function listConnectedAccountsForUser(
  composio: Composio,
  userId: string,
) {
  const accounts: any[] = [];
  let cursor: string | undefined;

  do {
    const page = await composio.connectedAccounts.list({
      userIds: [userId],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    accounts.push(...page.items);
    cursor = page.nextCursor || undefined;
  } while (cursor);

  return new Map(accounts.map((account) => [account.id, account]));
}

async function resolveAuthConfigId(
  composio: Composio,
  tool: Tool,
): Promise<string> {
  const rawConfigId = tool.composio_auth_config_id?.trim();
  if (rawConfigId && !rawConfigId.includes("placeholder")) {
    return rawConfigId;
  }

  const slug = tool.slug?.toLowerCase() || tool.toolkit_slug?.toLowerCase();
  if (slug && KNOWN_AUTH_CONFIGS[slug]) {
    return KNOWN_AUTH_CONFIGS[slug];
  }

  try {
    const configs = await composio.authConfigs.list();
    const match = configs?.items?.find(
      (config: any) =>
        config.toolkit?.slug?.toLowerCase() === slug ||
        config.name?.toLowerCase().includes(slug),
    );
    if (match?.id) {
      return match.id;
    }
  } catch (error) {
    console.warn(
      "[composioBackend] Failed to auto-discover auth config:",
      error,
    );
  }

  if (rawConfigId) {
    return rawConfigId;
  }

  throw new Error(
    `No valid composio_auth_config_id found for tool "${tool.name}" (${tool.slug}).`,
  );
}

function mapComposioStatus(status: string): ToolConnectionStatus | null {
  switch (status) {
    case "ACTIVE":
      return "connected";
    case "INITIALIZING":
    case "INITIATED":
      return "pending";
    case "FAILED":
      return "failed";
    case "EXPIRED":
    case "INACTIVE":
    case "REVOKED":
      return "revoked";
    default:
      return null;
  }
}

function getAccountEmail(account: any) {
  return (
    account.userEmail ||
    account.email ||
    account.params?.email ||
    account.params?.displayName ||
    account.data?.email ||
    account.data?.displayName ||
    null
  );
}

function getAccountLabel(account: any) {
  const email = getAccountEmail(account);
  return account.label || account.wordId || account.alias || email || null;
}

export interface StartConnectionParams {
  userId: string;
  toolId: string;
  callbackUrl?: string;
  userToken?: string;
}

export interface StartConnectionResult {
  success: boolean;
  toolId: string;
  toolName: string;
  connectUrl: string;
  connectionRequestId: string;
  composioConnectedAccountId?: string | null;
  status: ToolConnectionStatus;
}

export async function startToolConnection({
  userId,
  toolId,
  callbackUrl,
  userToken,
}: StartConnectionParams): Promise<StartConnectionResult> {
  if (!userId || !toolId) {
    throw new Error("userId and toolId are required to start tool connection.");
  }

  const composio = getComposioClient();
  const supabase = getSupabaseAdminClient(userToken);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      toolId,
    );
  const query = supabase.from("tools").select("*");
  const { data: tool, error } = await (isUuid
    ? query.eq("id", toolId).single()
    : query.eq("slug", toolId).single());

  if (error || !tool) {
    throw new Error(`Tool not found in Supabase for identifier: ${toolId}`);
  }

  const existingActive = await findActiveConnectedAccountForTool(
    composio,
    userId,
    tool,
  );
  if (existingActive) {
    await upsertConnection(
      supabase,
      userId,
      tool.id,
      "connected",
      existingActive,
    );
    return {
      success: true,
      toolId: tool.id,
      toolName: tool.name,
      connectUrl: "",
      connectionRequestId: existingActive.id,
      composioConnectedAccountId: existingActive.id,
      status: "connected",
    };
  }

  const authConfigId = await resolveAuthConfigId(composio, tool as Tool);

  console.log("[Composio auth config diagnostic]", {
    toolId: tool.id,
    toolName: tool.name,
    toolkitSlug: tool.toolkit_slug,
    authConfigId,
    hasAuthConfigId: Boolean(authConfigId),
  });

  const connectionRequest = await composio.connectedAccounts.link(
    userId,
    authConfigId,
    {
      allowMultiple: true,
      ...(callbackUrl ? { callbackUrl } : {}),
    },
  );

  const connectUrl =
    (connectionRequest as any).redirectUrl ||
    (connectionRequest as any).url ||
    (connectionRequest as any).link ||
    "";
  const connectedAccountId =
    (connectionRequest as any).connectedAccountId || null;

  await upsertConnection(
    supabase,
    userId,
    tool.id,
    "pending",
    connectedAccountId ? { id: connectedAccountId } : null,
    connectionRequest.id,
  );

  return {
    success: true,
    toolId: tool.id,
    toolName: tool.name,
    connectUrl,
    connectionRequestId: connectionRequest.id,
    composioConnectedAccountId: connectedAccountId,
    status: "pending",
  };
}

export interface CheckStatusParams {
  userId: string;
  toolId: string;
  userToken?: string;
}

export interface CheckStatusResult {
  success: boolean;
  toolId: string;
  status: ToolConnectionStatus;
  connectedLabel: string | null;
  connectedEmail: string | null;
  composioConnectedAccountId: string | null;
  composioConnectionRequestId: string | null;
  lastCheckedAt: string;
  verificationStatus: "verified" | "unavailable";
  verificationError?: string;
}

type StoredConnectionWithTool = UserToolConnection & {
  tools?:
    | { slug?: string; toolkit_slug?: string }
    | Array<{ slug?: string; toolkit_slug?: string }>;
};

async function syncStoredConnectionStatus(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  connection: StoredConnectionWithTool,
  userAccounts: Map<string, any>,
): Promise<CheckStatusResult> {
  const now = new Date().toISOString();
  const tool = Array.isArray(connection.tools)
    ? connection.tools[0]
    : connection.tools;
  const accountId = connection.composio_connected_account_id;
  const requestId = connection.composio_connection_request_id;
  const idToCheck = accountId || requestId;

  const save = async (updates: Record<string, unknown>) => {
    const { error } = await supabase
      .from("user_tool_connections")
      .update({ ...updates, last_checked_at: now })
      .eq("id", connection.id)
      .eq("user_id", userId);
    if (error)
      throw new Error(`Failed to update connection status: ${error.message}`);
  };

  const result = (
    status: ToolConnectionStatus,
    verificationStatus: "verified" | "unavailable",
    verificationError?: string,
    account?: any,
  ): CheckStatusResult => ({
    success: true,
    toolId: connection.tool_id,
    status,
    connectedLabel: account
      ? getAccountLabel(account)
      : connection.connected_label,
    connectedEmail: account
      ? getAccountEmail(account)
      : connection.connected_email,
    composioConnectedAccountId: account?.id || accountId || null,
    composioConnectionRequestId: status === "connected" ? null : requestId,
    lastCheckedAt: now,
    verificationStatus,
    ...(verificationError ? { verificationError } : {}),
  });

  if (!idToCheck) {
    if (connection.status === "connected" || connection.status === "pending") {
      await save({ status: "failed" });
      return result(
        "failed",
        "verified",
        "Connection details are missing. Reconnect to continue.",
      );
    }
    return result(connection.status, "verified");
  }

  const account = userAccounts.get(idToCheck);
  if (!account) {
    if (accountId) {
      await save({ status: "revoked" });
      return result(
        "revoked",
        "verified",
        "Reconnect this integration to continue.",
      );
    }
    if (connection.status === "pending") {
      return result(
        "pending",
        "unavailable",
        "Authorization is still pending. Check again shortly.",
      );
    }
    if (connection.status === "connected") {
      await save({ status: "failed" });
      return result(
        "failed",
        "verified",
        "Connection details are missing. Reconnect to continue.",
      );
    }
    return result(connection.status, "verified");
  }

  const accountToolkit = account.toolkit?.slug?.toLowerCase();
  const expectedToolkit = (
    tool?.toolkit_slug ||
    tool?.slug ||
    ""
  ).toLowerCase();
  if (accountToolkit && expectedToolkit && accountToolkit !== expectedToolkit) {
    await save({ status: "revoked" });
    return result(
      "revoked",
      "verified",
      "Reconnect this integration to continue.",
    );
  }

  const status = account.isDisabled
    ? "revoked"
    : mapComposioStatus(account.status);
  if (!status) {
    await save({});
    return result(
      connection.status,
      "unavailable",
      "Composio returned an unrecognized connection status.",
    );
  }

  await save({
    status,
    composio_connected_account_id: account.id,
    composio_connection_request_id: status === "pending" ? requestId : null,
    connected_label: getAccountLabel(account) || connection.connected_label,
    connected_email: getAccountEmail(account) || connection.connected_email,
    ...(status === "connected" && !connection.connected_at
      ? { connected_at: now }
      : {}),
  });
  return result(status, "verified", undefined, account);
}

export async function syncUserToolConnectionStatuses({
  userId,
  userToken,
}: {
  userId: string;
  userToken?: string;
}): Promise<CheckStatusResult[]> {
  if (!userId) throw new Error("Authenticated user is required.");

  const supabase = getSupabaseAdminClient(userToken);
  const { data: connections, error } = await supabase
    .from("user_tool_connections")
    .select("*, tools!inner(slug, toolkit_slug)")
    .eq("user_id", userId);
  if (error)
    throw new Error(`Failed to load tool connections: ${error.message}`);

  const composio = getComposioClient();
  let userAccounts: Map<string, any>;
  try {
    userAccounts = await listConnectedAccountsForUser(composio, userId);
  } catch (error: any) {
    console.warn("[composioBackend] Failed to list user's Composio accounts:", {
      userId,
      error: error?.message || error,
    });
    return ((connections || []) as StoredConnectionWithTool[]).map(
      (connection) => ({
        success: false,
        toolId: connection.tool_id,
        status: connection.status,
        connectedLabel: connection.connected_label,
        connectedEmail: connection.connected_email,
        composioConnectedAccountId: connection.composio_connected_account_id,
        composioConnectionRequestId: connection.composio_connection_request_id,
        lastCheckedAt: connection.last_checked_at || new Date().toISOString(),
        verificationStatus: "unavailable" as const,
        verificationError:
          "Could not verify this connection right now. The last known status is shown.",
      }),
    );
  }

  return Promise.all(
    ((connections || []) as StoredConnectionWithTool[]).map(
      async (connection) => {
        try {
          return await syncStoredConnectionStatus(
            supabase,
            userId,
            connection,
            userAccounts,
          );
        } catch (error: any) {
          console.warn(
            "[composioBackend] Failed to synchronize connection row:",
            {
              toolId: connection.tool_id,
              error: error?.message || error,
            },
          );
          return {
            success: false,
            toolId: connection.tool_id,
            status: connection.status,
            connectedLabel: connection.connected_label,
            connectedEmail: connection.connected_email,
            composioConnectedAccountId:
              connection.composio_connected_account_id,
            composioConnectionRequestId:
              connection.composio_connection_request_id,
            lastCheckedAt:
              connection.last_checked_at || new Date().toISOString(),
            verificationStatus: "unavailable" as const,
            verificationError:
              "Could not verify this connection right now. The last known status is shown.",
          };
        }
      },
    ),
  );
}

export async function checkToolConnectionStatus({
  userId,
  toolId,
  userToken,
}: CheckStatusParams): Promise<CheckStatusResult> {
  if (!userId || !toolId) {
    throw new Error(
      "userId and toolId are required to check connection status.",
    );
  }

  const supabase = getSupabaseAdminClient(userToken);
  const { resolvedToolId } = await resolveTool(supabase, toolId);

  const { data: connection, error } = await supabase
    .from("user_tool_connections")
    .select("*, tools!inner(slug, toolkit_slug)")
    .eq("user_id", userId)
    .eq("tool_id", resolvedToolId)
    .maybeSingle();
  if (error)
    throw new Error(`Failed to load tool connection: ${error.message}`);
  if (!connection) {
    const now = new Date().toISOString();
    return {
      success: true,
      toolId: resolvedToolId,
      status: "not_connected",
      connectedLabel: null,
      connectedEmail: null,
      composioConnectedAccountId: null,
      composioConnectionRequestId: null,
      lastCheckedAt: now,
      verificationStatus: "verified",
    };
  }

  const composio = getComposioClient();
  const userAccounts = await listConnectedAccountsForUser(composio, userId);
  return syncStoredConnectionStatus(
    supabase,
    userId,
    connection as StoredConnectionWithTool,
    userAccounts,
  );
}

export interface DisconnectParams {
  userId: string;
  toolId: string;
  userToken?: string;
}

export interface DisconnectResult {
  success: boolean;
  toolId: string;
  status: ToolConnectionStatus;
  message: string;
}

export async function disconnectToolConnection({
  userId,
  toolId,
  userToken,
}: DisconnectParams): Promise<DisconnectResult> {
  if (!userId || !toolId) {
    throw new Error("userId and toolId are required to disconnect tool.");
  }

  const composio = getComposioClient();
  const supabase = getSupabaseAdminClient(userToken);
  const { resolvedToolId } = await resolveTool(supabase, toolId);

  const { data: connection } = await supabase
    .from("user_tool_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("tool_id", resolvedToolId)
    .maybeSingle();

  if (connection) {
    const conn = connection as UserToolConnection;
    const accountId =
      conn.composio_connected_account_id || conn.composio_connection_request_id;
    if (accountId) {
      try {
        await composio.connectedAccounts.delete(accountId);
      } catch (error) {
        console.warn(
          `[composioBackend] Composio delete warning for ${accountId}:`,
          error,
        );
      }
    }

    const now = new Date().toISOString();
    await supabase
      .from("user_tool_connections")
      .update({
        status: "revoked",
        composio_connected_account_id: null,
        composio_connection_request_id: null,
        connected_label: null,
        connected_email: null,
        last_checked_at: now,
        updated_at: now,
      })
      .eq("id", conn.id);
  }

  return {
    success: true,
    toolId: resolvedToolId,
    status: "revoked",
    message: "Tool connection successfully disconnected and revoked.",
  };
}

async function resolveTool(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  toolId: string,
) {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      toolId,
    );
  const query = supabase.from("tools").select("*");
  const { data: tool } = await (isUuid
    ? query.eq("id", toolId).maybeSingle()
    : query.eq("slug", toolId).maybeSingle());

  return {
    tool,
    resolvedToolId: tool?.id || toolId,
  };
}

async function upsertConnection(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  toolId: string,
  status: ToolConnectionStatus,
  account?: any,
  requestId?: string | null,
) {
  const now = new Date().toISOString();

  const payload = {
    user_id: userId,
    tool_id: toolId,
    status,
    composio_connected_account_id: account?.id || null,
    composio_connection_request_id: requestId || null,
    connected_label: account ? getAccountLabel(account) : null,
    connected_email: account ? getAccountEmail(account) : null,
    connected_at: status === "connected" ? now : null,
    last_checked_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("user_tool_connections")
    .upsert(payload, { onConflict: "user_id,tool_id" })
    .select()
    .single();

  if (error) {
    console.error("[composioBackend] Failed to save user tool connection", {
      userId,
      toolId,
      status,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    throw new Error(`Failed to save ${status} connection: ${error.message}`);
  }

  console.log("[composioBackend] Connection saved", {
    userId,
    toolId,
    status: data.status,
    connectionRowId: data.id,
  });

  return data;
}
