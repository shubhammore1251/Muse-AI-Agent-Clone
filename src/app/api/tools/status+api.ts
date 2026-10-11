import {
    syncUserToolConnectionStatuses,
    validateUserFromRequest,
} from "@/lib/composioBackend";

/**
 * POST /api/tools/status
 * Refreshes all tool connections for the authenticated user and updates Supabase.
 */
export async function POST(req: Request) {
  try {
    const { userId, token } = await validateUserFromRequest(req);

    const results = await syncUserToolConnectionStatuses({
      userId,
      userToken: token,
    });

    return Response.json(
      {
        success: true,
        results,
      },
      { status: 200 },
    );
  } catch (error: any) {
    console.error("[POST /api/tools/status] Error:", error);
    return Response.json(
      { error: error?.message || "Failed to refresh tool connection states" },
      {
        status: error?.message?.includes("Unauthorized") ? 401 : 500,
      },
    );
  }
}

export async function GET(req: Request) {
  return POST(req);
}
