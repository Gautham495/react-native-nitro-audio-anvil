import Foundation

extension FixedWidthInteger {
  /// The integer's bytes in little-endian order, as used by RIFF/WAV headers.
  var anvilLittleEndianData: Data {
    withUnsafeBytes(of: self.littleEndian) { Data($0) }
  }
}
