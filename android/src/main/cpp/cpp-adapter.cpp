#include <jni.h>
#include "NitroAudioAnvilOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::audioanvil::initialize(vm);
}
