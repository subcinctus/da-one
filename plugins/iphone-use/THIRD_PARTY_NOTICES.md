# Third-party notices

iPhone Use for Claude Code is written in Python using only the Python standard library. It ships no third-party
code. This file lists the projects it is based on or works with, and their licenses.

## 1. iPhone-use by ZHONG XIN (MIT)

- Project: iPhone-use, a Codex plugin by ZHONG XIN, version 0.3.6
- Source: https://github.com/zhongerxin/iPhone-use
- License: MIT
- How it is used: design and behavior reference. This plugin is a fresh re-implementation for Claude Code; its tool
  set, safety rules, setup flow and operating guidance follow the behavior of iPhone-use 0.3.6.

```text
MIT License

Copyright (c) 2026 ZHONG XIN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Appium WebDriverAgent 16.14.0 (BSD-3-Clause)

- Project: Appium WebDriverAgent, version 16.14.0, commit `d17782422d55ff1e5e0ceb74eb1fd509cc0c35b6`
- Source: https://github.com/appium/WebDriverAgent
- License: BSD-3-Clause
- How it is used: WebDriverAgent is the helper app that runs on the iPhone. It is **not bundled** with this plugin.
  During setup the plugin downloads the pinned commit from GitHub onto the user's Mac, then builds and signs it there
  with the user's own Apple account. Setup also applies small local changes to two files of that downloaded copy:
  `WebDriverAgentLib/Routing/FBWebServer.m`, so that the iPhone's screen stream listens only on the iPhone itself
  by default (the plugin reaches it over the USB cable) and web pages are not allowed to read the helper's answers,
  and `WebDriverAgentLib/Routing/FBHTTPServer.m`, so that the helper refuses requests from web pages. The changes
  are made on the user's Mac and are not distributed. WebDriverAgent's own LICENSE file stays in the downloaded
  copy.

```text
BSD License

For WebDriverAgent software

Copyright (c) 2015-present, Facebook, Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 3. appium-ios-device 3.1.24 (Apache-2.0)

- Project: appium-ios-device, version 3.1.24
- Source: https://github.com/appium/appium-ios-device
- License: Apache-2.0
- How it is used: consulted only as a protocol reference for the usbmuxd wire format (message framing and the
  ListDevices and Connect requests). No code from it is included; the plugin's USB client is an independent Python
  implementation.
