import {
  checkToolConnectionStatus,
  validateUserFromRequest,
} from "@/lib/composioBackend";

/**
 * GET /api/tools/:toolId/status (or /tools/:toolId/status)
 * Checks the latest Composio connection status for a tool.
 */
export async function GET(
  req: Request,
  context?: { params?: { toolId?: string } } | any,
) {
  try {
    let toolId = context?.params?.toolId;
    const url = new URL(req.url);

    if (!toolId) {
      const segments = url.pathname.split("/").filter(Boolean);
      // Expected pathname formats: /api/tools/[toolId]/status or /tools/[toolId]/status
      const statusIdx = segments.indexOf("status");
      if (statusIdx > 0) {
        toolId = segments[statusIdx - 1];
      }
    }

    const queryUserId = url.searchParams.get("userId") || undefined;
    const { userId, token } = await validateUserFromRequest(req, queryUserId);

    if (!toolId) {
      return Response.json(
        { error: "Missing required parameter: toolId" },
        { status: 400 },
      );
    }

    const result = await checkToolConnectionStatus({
      userId,
      toolId,
      userToken: token,
    });

    return Response.json(result, { status: 200 });
  } catch (error: any) {
    console.error("[GET /tools/:toolId/status] Error:", error);
    return Response.json(
      { error: error?.message || "Failed to check connection status" },
      { status: error?.message?.includes("Unauthorized") ? 401 : 500 },
    );
  }
}
