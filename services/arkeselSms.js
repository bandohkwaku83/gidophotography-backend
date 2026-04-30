const SEND_URL = "https://sms.arkesel.com/api/v2/sms/send"

/**
 * @param {{ recipients: string[], message: string }} payload - recipients: 233XXXXXXXXX digits only
 * @returns {Promise<{ ok: boolean, data?: object, status?: number, error?: string }>}
 */
export async function sendArkeselSms({ recipients, message }) {
    const apiKey = process.env.ARKESEL_API_KEY?.trim()
    const sender = process.env.ARKESEL_SENDER_ID?.trim()

    if (!apiKey || !sender) {
        return {
            ok: false,
            error: "SMS is not configured (ARKESEL_API_KEY / ARKESEL_SENDER_ID)",
        }
    }

    if (!recipients?.length || !message) {
        return { ok: false, error: "recipients and message are required" }
    }

    try {
        const response = await fetch(SEND_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": apiKey,
            },
            body: JSON.stringify({
                sender,
                message,
                recipients,
            }),
        })

        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                error:
                    data.message ||
                    data.error ||
                    `HTTP ${response.status}`,
                data,
            }
        }

        if (data.code && String(data.code).toLowerCase() !== "ok") {
            return {
                ok: false,
                status: response.status,
                error: data.message || "Arkesel rejected the request",
                data,
            }
        }

        return { ok: true, data }
    } catch (err) {
        console.error("Arkesel SMS error:", err)
        return {
            ok: false,
            error: err.message || "Network error calling Arkesel",
        }
    }
}
