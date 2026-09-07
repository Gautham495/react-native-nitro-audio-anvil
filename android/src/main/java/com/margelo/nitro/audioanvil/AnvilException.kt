package com.margelo.nitro.audioanvil

/** Exception thrown from Anvil native code. Nitro surfaces the message to JS as the rejection reason. */
internal class AnvilException(val code: RecorderErrorCode, message: String) : RuntimeException("[$code] $message")
