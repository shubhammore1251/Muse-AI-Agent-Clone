import {
  startToolConnection,
  validateUserFromRequest,
} from "@/lib/composioBackend";

/**
 * POST /api/tools/:toolId/connect (or /tools/:toolId/connect)
 * Starts the Composio OAuth link flow for a user and specified toolId.
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
      // Expected pathname formats: /api/tools/[toolId]/connect or /tools/[toolId]/connect
      const connectIdx = segments.indexOf("connect");
      if (connectIdx > 0) {
        toolId = segments[connectIdx - 1];
      }
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // Validate user from Auth token or fallback userId from body
    const { userId, token } = await validateUserFromRequest(req, body.userId);

    if (!toolId) {
      return Response.json(
        { error: "Missing required parameter: toolId" },
        { status: 400 },
      );
    }

    const callbackUrl = body.callbackUrl;

    const result = await startToolConnection({
      userId,
      toolId,
      callbackUrl,
      userToken: token,
    });

    return Response.json(result, { status: 200 });
  } catch (error: any) {
    console.error("[POST /tools/:toolId/connect] Error:", error);
    return Response.json(
      { error: error?.message || "Failed to start tool connection" },
      { status: error?.message?.includes("Unauthorized") ? 401 : 500 },
    );
  }
}
