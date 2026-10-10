import {
  disconnectToolConnection,
  validateUserFromRequest,
} from "@/lib/composioBackend";

/**
 * POST /api/tools/:toolId/disconnect (or /tools/:toolId/disconnect)
 * Disconnects and revokes a tool connection in Composio and Supabase.
 */
export async function POST(
  req: Request,
  context?: { params?: { toolId?: string } } | any,
) {
  try {
    let toolId = context?.params?.toolId;

    if (!toolId) {
      const url = new URL(req.url);
      const segments = url.pathname.split("/").filter(Boolean);
      // Expected pathname formats: /api/tools/[toolId]/disconnect or /tools/[toolId]/disconnect
      const disconnectIdx = segments.indexOf("disconnect");
      if (disconnectIdx > 0) {
        toolId = segments[disconnectIdx - 1];
      }
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const { userId, token } = await validateUserFromRequest(req, body.userId);

    if (!toolId) {
      return Response.json(
        { error: "Missing required parameter: toolId" },
        { status: 400 },
      );
    }

    const result = await disconnectToolConnection({
      userId,
      toolId,
      userToken: token,
    });

    return Response.json(result, { status: 200 });
  } catch (error: any) {
    console.error("[POST /tools/:toolId/disconnect] Error:", error);
    return Response.json(
      { error: error?.message || "Failed to disconnect tool" },
      { status: error?.message?.includes("Unauthorized") ? 401 : 500 },
    );
  }
}
