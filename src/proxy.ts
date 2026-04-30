export type MethodMapGeneric = Record<string, (...args: any[]) => any>
export type MethodProxy<T extends MethodMapGeneric> = {
    [Name in keyof T]: (...args: Parameters<T[Name]>) => Promise<Awaited<ReturnType<T[Name]>>>
}
export function methodProxy<T extends MethodMapGeneric>(
    handler: <Name extends Extract<keyof T, string>>(
        name: Name,
        ...args: Parameters<T[Name]>
    ) => Promise<Awaited<ReturnType<T[Name]>>>
): MethodProxy<T> {
    return new Proxy({}, {
        get: (_, name: string) => {
            return (...args: any[]) => handler(name as Extract<keyof T, string>, ...args as Parameters<T[typeof name]>)
        }
    }) as MethodProxy<T>
}

export type BroadcastMethodProxy<T extends MethodMapGeneric> = {
    [Name in keyof T]: (...args: Parameters<T[Name]>) => Promise<Array<{ tabId: number, response: Awaited<ReturnType<T[Name]>> }>>
}

export function broadcastMethodProxy<T extends MethodMapGeneric>(
    handler: <Name extends Extract<keyof T, string>>(
        name: Name,
        ...args: Parameters<T[Name]>
    ) => Promise<Array<{ tabId: number, response: Awaited<ReturnType<T[Name]>> }>>
): BroadcastMethodProxy<T> {
    return new Proxy({} as BroadcastMethodProxy<T>, {
        get(_, prop) {
            if (typeof prop !== "string") return undefined;
            return (...args: any[]) => handler(prop as Extract<keyof T, string>, ...args as Parameters<T[typeof prop]>);
        }
    });
}   