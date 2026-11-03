/**
 * Plugin Event Bus — 外掛事件匯流排
 *
 * 使用 CustomEvent 模式，在 AegisTalk 與外掛之間傳遞事件。
 * 命名空間: aegis:plugin:{pluginId}:{eventName}
 */

type EventHandler = (detail: unknown) => void;

/** 組合事件名稱 */
function buildEventName(pluginId: string, eventName: string): string {
  return `aegis:plugin:${pluginId}:${eventName}`;
}

/**
 * 發送外掛事件
 */
export function emitPluginEvent(
  pluginId: string,
  eventName: string,
  detail: unknown,
): void {
  const fullName = buildEventName(pluginId, eventName);
  window.dispatchEvent(
    new CustomEvent(fullName, { detail }),
  );
}

/**
 * 監聽外掛事件
 * @returns 取消監聽的函式
 */
export function onPluginEvent(
  pluginId: string,
  eventName: string,
  handler: EventHandler,
): () => void {
  const fullName = buildEventName(pluginId, eventName);

  const listener = (e: Event) => {
    handler((e as CustomEvent).detail);
  };

  window.addEventListener(fullName, listener);
  return () => window.removeEventListener(fullName, listener);
}

/**
 * 監聽所有來自指定外掛的事件
 * 使用通配符模式：aegis:plugin:{pluginId}:*
 *
 * 注意：CustomEvent 不支援通配符，
 * 此函式用於外掛內部主動發送時路由。
 */
export function createPluginEventDispatcher(pluginId: string) {
  return {
    emit: (eventName: string, detail: unknown) =>
      emitPluginEvent(pluginId, eventName, detail),
    on: (eventName: string, handler: EventHandler) =>
      onPluginEvent(pluginId, eventName, handler),
  };
}
