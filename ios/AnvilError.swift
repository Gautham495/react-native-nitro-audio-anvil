import Foundation

/// Error thrown from Anvil native code. Nitro surfaces `description` to JS as the rejection message.
struct AnvilError: Error, CustomStringConvertible, LocalizedError {
  let code: RecorderErrorCode
  let message: String

  init(_ code: RecorderErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }

  var description: String { "[\(code)] \(message)" }
  var errorDescription: String? { description }
}
