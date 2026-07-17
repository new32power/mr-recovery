// In-memory intercept state for master panel
const intercepted = new Set<string>();

export const interceptState = {
  list: async () => Array.from(intercepted),
  enable: async (deviceId: string) => { intercepted.add(deviceId); },
  disable: async (deviceId: string) => { intercepted.delete(deviceId); },
  isEnabled: (deviceId: string) => intercepted.has(deviceId),
};
