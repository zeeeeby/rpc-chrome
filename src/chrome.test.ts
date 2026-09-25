import { describe, it, expect, vi, beforeEach } from "vitest"
import { Requester } from "./chrome"

const sendMessageMock = vi.fn()
const tabsQueryMock = vi.fn()
const tabsSendMessageMock = vi.fn()

vi.stubGlobal("chrome", {
    runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
    },
    tabs: {
        query: tabsQueryMock,
        sendMessage: tabsSendMessageMock,
        TAB_ID_NONE: -1
    }
})

type Messages = {
    ping: (x: number) => string
}

describe("Requester", () => {
    beforeEach(() => {
        sendMessageMock.mockReset().mockResolvedValue("pong")
        tabsQueryMock.mockReset()
        tabsSendMessageMock.mockReset().mockResolvedValue("pong")
    })

    it("to() sends to queried tabs and runtime once", async () => {
        tabsQueryMock.mockImplementation((_query, cb) => cb([{ id: 1 }, { id: 2 }]))
        sendMessageMock.mockResolvedValue("pong")

        const requester = new Requester<Messages>("test-channel")
        const promise = requester.to({ url: "https://example.com/*" }).ping(42)

        expect(tabsQueryMock).toHaveBeenCalledWith({ url: "https://example.com/*" }, expect.any(Function))
        expect(tabsSendMessageMock).toHaveBeenCalledTimes(2)
        expect(tabsSendMessageMock).toHaveBeenCalledWith(1, {
            type: "request",
            channel: "test-channel",
            method: "ping",
            args: [42]
        })
        expect(tabsSendMessageMock).toHaveBeenCalledWith(2, {
            type: "request",
            channel: "test-channel",
            method: "ping",
            args: [42]
        })
        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect(sendMessageMock).toHaveBeenCalledWith({
            type: "request",
            channel: "test-channel",
            method: "ping",
            args: [42]
        })
        await expect(promise).resolves.toBe("pong")
    })

    it("to() skips tabs with invalid id", () => {
        tabsQueryMock.mockImplementation((_query, cb) => cb([{ id: 1 }, {}, { id: chrome.tabs.TAB_ID_NONE }]))

        const requester = new Requester<Messages>("test-channel")
        requester.to({}).ping(1)

        expect(tabsSendMessageMock).toHaveBeenCalledTimes(1)
        expect(tabsSendMessageMock).toHaveBeenCalledWith(1, expect.anything())
    })

    it("call() without queryInfo does not query tabs", () => {
        sendMessageMock.mockResolvedValue("ok")

        const requester = new Requester<Messages>("test-channel")
        requester.call("ping", 1)

        expect(tabsQueryMock).not.toHaveBeenCalled()
        expect(sendMessageMock).toHaveBeenCalledTimes(1)
    })

    it("call() with queryInfo broadcasts and sends runtime", () => {
        tabsQueryMock.mockImplementation((_query, cb) => cb([{ id: 7 }]))
        sendMessageMock.mockResolvedValue("ok")

        const requester = new Requester<Messages>("test-channel", {})
        requester.call("ping", 1)

        expect(tabsQueryMock).toHaveBeenCalledWith({}, expect.any(Function))
        expect(tabsSendMessageMock).toHaveBeenCalledWith(7, {
            type: "request",
            channel: "test-channel",
            method: "ping",
            args: [1]
        })
        expect(sendMessageMock).toHaveBeenCalledTimes(1)
    })
})
