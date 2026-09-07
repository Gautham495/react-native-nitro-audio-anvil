package com.margelo.nitro.nitroaudioanvil
  
import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class NitroAudioAnvil : HybridNitroAudioAnvilSpec() {
  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }
}
