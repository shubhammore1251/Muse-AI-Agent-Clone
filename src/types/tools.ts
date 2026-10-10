/**
 * Composio Tools & User Tool Connections Data Types
 */

/**
 * Status of a user's tool connection.
 */
export type ToolConnectionStatus =
  | "not_connected"
  | "pending"
  | "connected"
  | "failed"
  | "revoked";

/**
 * Tool Action definition schema
 */
export interface ToolAction {
  name: string;
  description: string;
}

/**
 * Tool entity stored in Supabase `tools` table
 */
export interface Tool {
  id: string;
  name: string;
  slug: string;
  toolkit_slug: string;
  description: string | null;
  category: string | null;
  logo_url: string | null;
  icon_url?: string | null;
  logo_key: string | null;
  actions: ToolAction[];
  composio_auth_config_id?: string | null;
  is_active?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * User tool connection entity stored in Supabase `user_tool_connections` table
 */
export interface UserToolConnection {
  id: string;
  user_id: string;
  tool_id: string;
  status: ToolConnectionStatus;
  composio_connected_account_id: string | null;
  composio_connection_request_id: string | null;
  connected_label: string | null;
  connected_email: string | null;
  metadata?: Record<string, any> | null;
  last_checked_at?: string | null;
  connected_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Combined tool data returned to the app UI, including tool details and connection status
 */
export interface ToolWithConnection {
  id: string;
  name: string;
  slug: string;
  toolkit_slug: string;
  description: string | null;
  category: string | null;
  logo_url: string | null;
  icon_url?: string | null;
  logo_key: string | null;
  actions: ToolAction[];
  status: ToolConnectionStatus;
  connected_label: string | null;
  connected_email: string | null;
  composio_auth_config_id?: string | null;
  composio_connected_account_id?: string | null;
  statusVerification?: "verified" | "unavailable";
  statusVerificationError?: string | null;
}

/**
 * Connected Tool Context schema returned for the AI agent context
 */
export interface ConnectedToolContext {
  tool_id: string;
  name: string;
  slug: string;
  toolkit_slug: string;
  actions: ToolAction[];
  composio_connected_account_id: string | null;
  connected_label: string | null;
  connected_email?: string | null;
}

/**
 * Tool execution log entity for Supabase `agent_tool_runs` table
 */
export interface AgentToolRunLog {
  id?: string;
  user_id: string;
  tool_id?: string | null;
  action_name: string;
  input_summary: string;
  output_summary?: string | null;
  status: "pending" | "completed" | "failed" | "cancelled";
  error_message?: string | null;
  metadata?: Record<string, any> | null;
  created_at?: string;
}

/**
 * Backend API responses for tool connections
 */
export interface StartConnectionResponse {
  success: boolean;
  toolId: string;
  toolName: string;
  connectUrl: string;
  connectionRequestId: string;
  composioConnectedAccountId?: string | null;
  status: ToolConnectionStatus;
}

export interface CheckStatusResponse {
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

export interface SyncToolStatusesResponse {
  success: boolean;
  results: CheckStatusResponse[];
}

export interface DisconnectResponse {
  success: boolean;
  toolId: string;
  status: ToolConnectionStatus;
  message: string;
}
