import Constants from "expo-constants";

export function getApiUrl(path: string) {
  const hostUrl = Constants.expoConfig?.hostUri;
  return `http://${hostUrl}/api${path}`;
}
