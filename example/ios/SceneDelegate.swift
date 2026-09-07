//
//  SceneDelegate.swift
//  NitroAudioAnvilExample
//
//  Created by Gautham Vijayan on 07/09/26.
//

import UIKit
import React
import React_RCTAppDelegate

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {

    guard let windowScene = scene as? UIWindowScene else {
      return
    }

    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    // Create the window for this scene.
    let window = UIWindow(windowScene: windowScene)

    self.window = window
    appDelegate.window = window

    // React Native factory must have been initialized by AppDelegate.
    guard let factory = appDelegate.reactNativeFactory else {
      fatalError("React Native factory was not initialized")
    }

    factory.startReactNative(
      withModuleName: "NitroAudioAnvilExample",
      in: window,
      launchOptions: connectionOptions.userActivities.first.map {
        [
          UIApplication.LaunchOptionsKey.userActivityDictionary.rawValue: $0
        ]
      }
    )

    // URL deep link that launched the app.
    if let urlContext = connectionOptions.urlContexts.first {
      _ = RCTLinkingManager.application(
        UIApplication.shared,
        open: urlContext.url,
        options: [:]
      )
    }

    // Universal link / Siri intent that launched the app.
    if let userActivity = connectionOptions.userActivities.first {
      _ = RCTLinkingManager.application(
        UIApplication.shared,
        continue: userActivity,
        restorationHandler: { _ in }
      )
    }
  }

  // MARK: - Deep Linking

  func scene(
    _ scene: UIScene,
    openURLContexts URLContexts: Set<UIOpenURLContext>
  ) {

    guard let urlContext = URLContexts.first else {
      return
    }

    _ = RCTLinkingManager.application(
      UIApplication.shared,
      open: urlContext.url,
      options: [:]
    )
  }

  // MARK: - Universal Links

  func scene(
    _ scene: UIScene,
    continue userActivity: NSUserActivity
  ) {

    _ = RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }
}