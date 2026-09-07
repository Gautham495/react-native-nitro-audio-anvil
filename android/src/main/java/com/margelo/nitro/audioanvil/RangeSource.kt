package com.margelo.nitro.audioanvil

import java.io.File

/** A segment file (closed or still open) with its position on the recording timeline. */
internal class RangeSource(val file: File, val mediaStartMs: Double, val dataBytes: Int)
