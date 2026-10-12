import { createContext, useCallback, useContext, useState } from "react";

export type ChatAction = "export" | "clear" | "delete";
type ChatActionHandler = () => void | Promise<void>;
export type ChatHeaderIdentity = {
  threadId: string | null;
  type: "main" | "side";
  title: string;
};

type ChatExportContextValue = {
  registerChatAction: (
    action: ChatAction,
    handler: ChatActionHandler | null,
  ) => () => void;
  requestChatAction: (action: ChatAction) => Promise<boolean>;
  chatHeaderIdentity: ChatHeaderIdentity;
  setChatHeaderIdentity: (identity: ChatHeaderIdentity) => void;
  appHeaderHeight: number;
  setAppHeaderHeight: (height: number) => void;
};

const ChatExportContext = createContext<ChatExportContextValue | null>(null);

export function ChatExportProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [handlers, setHandlers] = useState<
    Partial<Record<ChatAction, ChatActionHandler>>
  >({});
  const [pendingRequests, setPendingRequests] = useState<ChatAction[]>([]);
  const [chatHeaderIdentity, setChatHeaderIdentity] =
    useState<ChatHeaderIdentity>({
      threadId: null,
      type: "main",
      title: "Main Chat",
    });
  const [appHeaderHeight, setAppHeaderHeight] = useState(0);

  const registerChatAction = useCallback(
    (action: ChatAction, handler: ChatActionHandler | null) => {
      setHandlers((current) => ({
        ...current,
        [action]: handler ?? undefined,
      }));
      if (handler && pendingRequests.includes(action)) {
        setPendingRequests((current) =>
          current.filter((pendingAction) => pendingAction !== action),
        );
        void Promise.resolve(handler()).catch((error) => {
          console.error(`Queued ${action} action failed:`, error);
        });
      }
      return () => {
        setHandlers((current) => {
          if (current[action] !== handler) return current;
          const next = { ...current };
          delete next[action];
          return next;
        });
      };
    },
    [pendingRequests],
  );
  const requestChatAction = useCallback(
    async (action: ChatAction) => {
      const handler = handlers[action];
      if (!handler) {
        setPendingRequests((current) =>
          current.includes(action) ? current : [...current, action],
        );
        return false;
      }
      await handler();
      return true;
    },
    [handlers],
  );

  return (
    <ChatExportContext.Provider
      value={{
        registerChatAction,
        requestChatAction,
        chatHeaderIdentity,
        setChatHeaderIdentity,
        appHeaderHeight,
        setAppHeaderHeight,
      }}
    >
      {children}
    </ChatExportContext.Provider>
  );
}

export function useChatExport() {
  const context = useContext(ChatExportContext);
  if (!context) {
    throw new Error("useChatExport must be used within ChatExportProvider");
  }
  return context;
}
