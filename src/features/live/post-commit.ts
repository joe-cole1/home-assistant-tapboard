type Observer = (result: unknown, args: readonly unknown[]) => void;

/**
 * Decorate selected application-service calls with a synchronous notification
 * that runs only after the call (and therefore its transaction) succeeds.
 */
export function observeCommittedCalls<T extends object>(
  service: T,
  observers: Readonly<Partial<Record<keyof T, Observer>>>,
): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;

      return (...args: unknown[]): unknown => {
        const result = Reflect.apply(value, target, args) as unknown;
        const observer = observers[property as keyof T];
        if (result instanceof Promise) {
          const pending = result as Promise<unknown>;
          return pending.then((resolved: unknown) => {
            observer?.(resolved, args);
            return resolved;
          });
        }
        observer?.(result, args);
        return result;
      };
    },
  });
}
