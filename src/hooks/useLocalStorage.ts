import { useState, useCallback } from "react";

// Module-level defaults keep a stable identity across renders so the setValue
// callback's dependency array does not churn (react/exhaustive-deps is error).
const defaultSerialize = <T>(value: T): string => JSON.stringify(value);

// SAFETY: JSON.parse returns the same T the hook was parameterized with; the
// caller owns T's serializability, matching the options.deserialize contract.
const defaultDeserialize = <T>(value: string): T => JSON.parse(value) as T;

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (value: string) => T;
  }
) {
  const serialize = options?.serialize || defaultSerialize;
  const deserialize = options?.deserialize || defaultDeserialize<T>;

  const [state, setState] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);

      if (item === null) {
        // Persist the default so direct localStorage.getItem() reads
        // (e.g. in audioManager) see the intended value.
        localStorage.setItem(key, serialize(defaultValue));

        return defaultValue;
      }

      return deserialize(item);
    } catch {
      return defaultValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prevState: T) => T)) => {
      setState((currentState) => {
        try {
          const valueToStore = value instanceof Function ? value(currentState) : value;
          localStorage.setItem(key, serialize(valueToStore));

          return valueToStore;
        } catch (error) {
          console.error(`Error setting localStorage key "${key}":`, error);

          return currentState;
        }
      });
    },
    [key, serialize]
  );

  const remove = useCallback(() => {
    try {
      localStorage.removeItem(key);
      setState(defaultValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, defaultValue]);

  return [state, setValue, remove] as const;
}
