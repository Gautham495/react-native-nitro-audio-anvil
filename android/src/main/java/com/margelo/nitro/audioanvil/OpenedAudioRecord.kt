package com.margelo.nitro.audioanvil

import android.media.AudioRecord

/** An initialized AudioRecord together with the sample rate it was actually opened at. */
internal class OpenedAudioRecord(val record: AudioRecord, val sampleRate: Int)
