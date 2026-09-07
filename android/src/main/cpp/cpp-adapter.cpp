#include <jni.h>
#include "nitroaudioanvilOnLoad.hpp"

#include <fbjni/fbjni.h>


JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::nitroaudioanvil::registerAllNatives();
  });
}