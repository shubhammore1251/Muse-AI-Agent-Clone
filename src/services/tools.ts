import { supabase } from "@/lib/supabase";
import {
    CheckStatusResponse,
    DisconnectResponse,
    StartConnectionResponse,
    SyncToolStatusesResponse,
    Tool,
    ToolAction,
    ToolWithConnection,
    UserToolConnection,
} from "@/types/tools";
import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Fetch active tools directly from Supabase `tools` table.
 */
export const fetchToolsFromSupabase = async (): Promise<Tool[]> => {
  const { data, error } = await supabase
    .from("tools")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error(
      "[tools.ts] Supabase query error fetching tools:",
      error.message,
    );
    throw error;
  }

  return (data as Tool[]) || [];
};

/**
 * Fetch tool connections for a specific user from Supabase `user_tool_connections` table.
 */
export const getUserToolConnections = async (
  userId: string,
): Promise<UserToolConnection[]> => {
  if (!userId) {
    return [];
  }

  const { data, error } = await supabase
    .from("user_tool_connections")
    .select("*")
    .eq("user_id", userId);

  if (error) {
    console.warn(
      "[tools.ts] Error fetching user_tool_connections:",
      error.message,
    );
    return [];
  }

  return (data as UserToolConnection[]) || [];
};

/**
 * Main service function to fetch tools directly from Supabase combined with current user's connection status.
 *
 * Does NOT use mock tools.
 *
 * @param userId - Optional Supabase Auth user ID. If not provided, will attempt to fetch current auth user.
 * @returns Array of ToolWithConnection from Supabase database.
 */
export const fetchToolsWithUserConnection = async (
  userId?: string,
): Promise<ToolWithConnection[]> => {
  // 1. Fetch active tools from Supabase
  const tools = await fetchToolsFromSupabase();

  if (!tools || tools.length === 0) {
    return [];
  }

  // 2. Resolve user ID if not explicitly passed
  let activeUserId = userId;
  if (!activeUserId) {
    const { data: authData } = await supabase.auth.getUser();
    activeUserId = authData?.user?.id;
  }

  // 3. Fetch user connections if authenticated user exists
  let connections: UserToolConnection[] = [];
  if (activeUserId) {
    connections = await getUserToolConnections(activeUserId);
  }

  // Map connections by tool_id for fast lookup
  const connectionMap = new Map<string, UserToolConnection>();
  connections.forEach((conn) => {
    connectionMap.set(conn.tool_id, conn);
  });

  // 4. Combine Supabase tool data with user connection status
  const result: ToolWithConnection[] = tools.map((tool) => {
    const conn = connectionMap.get(tool.id);

    // Parse actions safely if stored as JSON/string
    let parsedActions: ToolAction[] = [];
    if (Array.isArray(tool.actions)) {
      parsedActions = tool.actions;
    } else if (typeof tool.actions === "string") {
      try {
        parsedActions = JSON.parse(tool.actions);
      } catch {
        parsedActions = [];
      }
    }

    return {
      id: tool.id,
      name: tool.name,
      slug: tool.slug,
      toolkit_slug: tool.toolkit_slug,
      description: tool.description,
      category: tool.category,
      logo_url: tool.logo_url,
      icon_url: (tool as any).icon_url || tool.logo_url || null,
      logo_key: tool.logo_key,
      actions: parsedActions,
      status: conn ? conn.status : "not_connected",
      connected_label: conn ? conn.connected_label : null,
      connected_email: conn ? conn.connected_email : null,
      composio_auth_config_id: tool.composio_auth_config_id,
      composio_connected_account_id: conn
        ? conn.composio_connected_account_id
        : null,
    };
  });

  return result;
};

/**
 * Requirement 1: Connected tools context helper.
 * Returns active connected tools for the current user with details:
 * - toolkit_slug
 * - tool name
 * - actions
 * - composio_connected_account_id
 * - connected_label
 */
export const getConnectedToolsContext = async (
  userId?: string,
): Promise<import("@/types/tools").ConnectedToolContext[]> => {
  const toolsWithConn = await fetchToolsWithUserConnection(userId);
  return toolsWithConn
    .filter((t) => t.status === "connected")
    .map((t) => ({
      tool_id: t.id,
      name: t.name,
      slug: t.slug,
      toolkit_slug: t.toolkit_slug,
      actions: t.actions,
      composio_connected_account_id: t.composio_connected_account_id || null,
      connected_label: t.connected_label || null,
      connected_email: t.connected_email || null,
    }));
};

/**
 * Requirement 6: Tool run logging helper.
 * Logs tool execution details to `agent_tool_runs` table in Supabase.
 */
export const logToolRun = async (
  log: import("@/types/tools").AgentToolRunLog,
): Promise<any> => {
  let userId = log.user_id;
  if (!userId) {
    const { data: authData } = await supabase.auth.getUser();
    userId = authData?.user?.id || "";
  }

  if (!userId) {
    console.warn("[tools.ts] Cannot log tool run: User ID is missing");
    return null;
  }

  const payload = {
    user_id: userId,
    tool_id: log.tool_id || null,
    action_name: log.action_name,
    input_summary: log.input_summary,
    output_summary: log.output_summary || null,
    status: log.status,
    error_message: log.error_message || null,
    metadata: log.metadata || {},
  };

  const { data, error } = await supabase
    .from("agent_tool_runs")
    .insert([payload])
    .select()
    .single();

  if (error) {
    console.error(
      "[tools.ts] Error logging tool run to agent_tool_runs:",
      error.message,
    );
    return null;
  }

  return data;
};

/**
 * Helper to resolve API base URL for non-web (mobile) fetch calls.
 */
function getApiBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }
  const hostUri =
    Constants.expoConfig?.hostUri ||
    (Constants as any).manifest2?.extra?.expoGo?.debuggerHost;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    const port = hostUri.split(":")[1] || "8081";
    return `http://${host}:${port}`;
  }
  return "http://localhost:8081";
}

/**
 * Helper to execute backend endpoint requests with Auth token.
 */
async function callToolApi<T = any>(
  endpointPath: string,
  options: { method?: string; body?: any } = {},
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const userId = sessionData?.session?.user?.id;

  // console.log("callToolApi:", endpointPath, options);
  // console.log("callToolApi:", sessionData?.session?.user);
  // console.log("callToolApi:", userId);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const method = options.method || "GET";
  const reqBody = options.body ? { userId, ...options.body } : undefined;

  let url = endpointPath;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    if (Platform.OS !== "web") {
      const baseUrl = getApiBaseUrl();
      url = `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
    }
  }

  const res = await fetch(url, {
    method,
    headers,
    body: reqBody ? JSON.stringify(reqBody) : undefined,
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(
      json.error || `API Request failed with status ${res.status}`,
    );
  }

  return json as T;
}

/**
 * 1. Start Composio Connection
 * POST /tools/:toolId/connect (or /api/tools/:toolId/connect)
 */
export const startToolConnectionApi = async (
  toolId: string,
  callbackUrl?: string,
): Promise<StartConnectionResponse> => {
  return callToolApi<StartConnectionResponse>(
    `/api/tools/${encodeURIComponent(toolId)}/connect`,
    {
      method: "POST",
      body: { callbackUrl },
    },
  );
};

/**
 * 2. Check Connection Status
 * GET /tools/:toolId/status (or /api/tools/:toolId/status)
 */
export const checkToolConnectionStatusApi = async (
  toolId: string,
): Promise<CheckStatusResponse> => {
  return callToolApi<CheckStatusResponse>(
    `/api/tools/${encodeURIComponent(toolId)}/status`,
    {
      method: "GET",
    },
  );
};

/** Refreshes every stored connection for the authenticated user on the backend. */
export const refreshToolConnectionStatusesApi =
  async (): Promise<SyncToolStatusesResponse> => {
    return callToolApi<SyncToolStatusesResponse>("/api/tools/status", {
      method: "POST",
    });
  };

/**
 * 3. Disconnect Tool Connection
 * POST /tools/:toolId/disconnect (or /api/tools/:toolId/disconnect)
 */
export const disconnectToolApi = async (
  toolId: string,
): Promise<DisconnectResponse> => {
  return callToolApi<DisconnectResponse>(
    `/api/tools/${encodeURIComponent(toolId)}/disconnect`,
    {
      method: "POST",
    },
  );
};
