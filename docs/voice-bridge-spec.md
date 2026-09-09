# Voice Bridge — Product Specification

Written in ASD-STE100 Simplified Technical English.
Feature level only. No code.

Date: 9 September 2026. Open points resolved.

This document is the complete specification for the voice bridge product. It
includes the background, the settled design decisions, the reasoning behind
them, the full feature set, the technology choices, the build order, the
lessons from prior art, the risks, and the configuration. The document is
complete on its own. A builder can start from this document.

The voice bridge is a new product. The voice bridge is not this repository.
The bridge in this repository is the project bridge of Section 2.7. The
project bridge stays in place.

## 1. PURPOSE

1.1 The voice bridge lets Chris drive a Claude Code session by voice from his phone.

1.2 The bridge runs on Chris's desktop machine.

1.3 The phone sends speech to the bridge. The bridge sends speech back to the phone.

1.4 The goal is a spoken conversation that feels like the Claude app voice mode, but with the desktop Claude Code as the reasoning engine.

1.5 The product is not tied to one project. The product works with any project on the machine.

## 2. BACKGROUND AND REASONING

2.1 The first question was whether the voice bridge and the cross-session memory belong inside aleph. The answer is that the memory is already aleph, and the voice bridge is mostly not aleph.

2.2 The vault is already the memory. Aleph writes the vault. A hook adds the map and the standing context at the start of each session. This covers memory across sessions on the machine. The gap is memory across surfaces. A plain chat on the phone cannot read the vault. A Cowork session in the cloud cannot read the vault.

2.3 The voice bridge splits into parts. The part that captures speech and holds a warm Claude Code process cannot live in aleph, because this part starts Claude Code. A plugin runs inside Claude Code, not around it. This part belongs in its own repository. Two small parts do belong in aleph. The first is a hook that says which tool is about to run, so a long turn does not sound like a dropped call. The second is the tracing, which already works.

2.4 Decision one: this product does not need a telephone call. The earlier plan used telephony because Apple does not let a web page keep the microphone open when the screen is locked. If the screen stays on, this limit does not apply, and the call gives no benefit. Voice mode with the screen on is the target. A later native app removes the screen-on limit by a different method (see Section 17).

2.5 Decision two: the app is not the brain. The Claude app can reach the machine through a connector. Chris has used this since 6 September 2026. But if the app does the reasoning and the machine holds only the tools, the product loses the Claude Code loop, the instructions file, the skills, and the subagents. This loss is acceptable when the logic of a project is already in its own command-line tool. This loss is not acceptable when the reasoning is the actual work.

2.6 Decision three: the product is not tied to one project. The project bridge is generic in its mechanism, but it needs a hand-written verb list for each project, and it cannot help a project that has no command-line tool. One bridge that starts Claude Code in any directory is the better answer. This bridge needs nothing for each project, because the instructions file of each project already holds its rules.

2.7 The existing project bridge stays in place. Nothing is deleted. The existing bridge continues to work for the story pipeline while the general bridge is built.

## 3. SYSTEM PARTS

3.1 The client is a page or an app on the phone. The client opens the microphone. The client sends audio to the bridge. The client plays audio from the bridge.

3.2 The bridge runs on the desktop machine. The bridge changes speech to text. The bridge sends text to Claude Code. The bridge changes reply text to speech.

3.3 Claude Code is one process on the desktop machine. Claude Code stays alive for the full conversation. Claude Code reads text only. Claude Code does not read or make audio.

3.4 The voice engine is a function of the bridge. The voice engine is not a function of the app. The voice engine is not a function of Claude Code.

3.5 Two results follow. First, Claude Code needs no change to work by voice. Second, each voice decision lives in the bridge, where it can change without a change to the agent.

## 4. TECHNOLOGY CHOICES

4.1 Transport and real-time audio use LiveKit over WebRTC. Do not build the transport by hand. Do not use plain websockets. WebRTC is made for an open microphone during playback, for barge-in, and for a connection that drops and hands off between towers in a car. LiveKit is the proven framework over WebRTC for real-time voice agents.

4.2 LiveKit gives the echo cancellation at the framework level, across the browser and the native app. The bridge does not build its own echo cancellation.

4.3 LiveKit separates the control channel from the audio channel. Control events do not compete with audio frames.

4.4 LiveKit has a native Android SDK. The same transport, the same framework, and the same echo cancellation carry over from the web client to the Android app. The bridge does not change when the client changes.

4.5 The speech engine is fully local on the desktop machine. This is not a default. This is a constraint. No part of the voice path goes to a cloud service, in any mode, at any time. Speech-to-text is local. Text-to-speech is local. Wake-word matching is local. This removes the per-use cost, keeps the audio private, and removes a network hop that a car connection would make slow.

4.6 Speech-to-text uses a small Whisper-family model. This uses about two gigabytes of video memory and transcribes faster than real time.

4.7 Text-to-speech uses a quality local neural voice. The machine has an eight-gigabyte GPU. The speech-to-text and the text-to-speech both fit on this GPU and leave headroom. The machine is idle when Chris is out, so the GPU is free.

4.8 The speech-to-text engine and the text-to-speech engine are both replaceable parts. Each engine sits behind an interface. The interface accepts local engines only. Do not add a cloud engine, and do not add a cloud fallback for a local engine that fails or gives a bad result.

4.9 The builder selects the first working local voice and does not wait for a decision. Chris changes the voice later with a setting.

4.10 The GPU budget for the voice path is eight gigabytes. This is the whole GPU. The speech-to-text model and the text-to-speech model must fit together in this budget and leave headroom. Select each model against this budget.

4.11 The machine does no other GPU work while the bridge runs. The GPU is therefore not shared, and contention is not a risk of this design.

4.12 The local-only constraint of 4.5 makes the GPU a hard dependency, and 4.11 is the condition that makes this safe. If the machine later does other GPU work, there is no cloud path to fall back on, and the models of 4.6 and 4.9 must get smaller instead.

## 5. SIGNAL CHAIN

5.1 The client opens the microphone.

5.2 The client sends the audio to the bridge over LiveKit.

5.3 The bridge changes the speech to text with the local model.

5.4 The bridge sends the text to the Claude Code process.

5.5 The Claude Code process sends back the reply as text, word by word.

5.6 The bridge collects the words to the end of a sentence.

5.7 The bridge changes the sentence to speech with the local voice.

5.8 The bridge sends the speech to the client over LiveKit.

5.9 The client plays the speech.

## 6. SETTLED DESIGN DECISIONS

6.1 A project declares nothing. The bridge starts Claude Code in the project directory. The instructions file of the project gives the agent its rules. Do not keep verb lists.

6.2 The agent works in a separate work tree. The agent does not work on the main checkout.

6.3 The agent is permissive by default. A small set of actions are gated. A gated action needs spoken agreement.

6.4 The system uses two memory stores. Claude memory holds pointers and current state. The vault holds the full notes. A test confirmed that Claude memory works across surfaces.

6.5 The voice instruction lives in the bridge. The voice instruction does not live in the aleph identity file. This keeps behavioral modes out of aleph.

6.6 The voice instruction tells the agent that it is in a spoken conversation. The agent does not read a file path aloud. The agent does not read a diff aloud. The agent does not read code aloud. The agent does not read secrets aloud. The agent gives a summary instead.

6.7 Every value that this document gives as a default is a setting. Section 21 lists the settings. A builder does not write a value of this kind into the code as a constant.

## 7. BUILD ORDER

7.1 Build the narration hook in aleph first. The narration hook says which tool is about to run. This part is small and useful on its own.

7.2 Build the text round trip second. Test the full loop in text. The text loop is useful even if voice does not come.

7.3 Build voice third. Add voice on top of the text loop.

7.4 Build the screen-on web client as the first phone client. Accept that the screen must stay on.

7.5 Build a private native Android app last. The app supports screen-off voice with a foreground service. Do not publish the app.

7.6 The build starts now. The measurements of Section 18 do not block the build. Make each measurement during the build.

## 8. PROCESS MANAGEMENT

8.1 The bridge keeps the Claude Code process stable. Stability is a top priority.

8.2 The bridge monitors the health of the process. The bridge does extra self-management because of the JSON API.

8.3 The bridge uses three independent fault detectors. Each detector finds a different kind of fault. The silence detector finds a process that stopped. The compaction-loop detector finds a process that is busy but stuck. The hard ceiling catches any fault that gets past the first two.

8.4 The silence detector.

8.4.1 The silence detector watches all output from the process, not only the spoken reply. It watches the text output, the tool calls, and the movement of tokens. Output of any kind on any channel is activity.

8.4.2 The detector starts its timer only when all output stops at the same time. A process that is busy on a hard task still sends output, so the timer does not start. Activity resets the timer.

8.4.3 The default silence time is one minute. If the process sends nothing on any channel for one minute, the bridge restarts the process.

8.4.4 The silence time is a setting.

8.5 The compaction-loop detector.

8.5.1 Claude Code prints a message when it compacts the conversation. In a healthy session this happens rarely. In a fault it happens again and again in a short time.

8.5.2 The detector counts the compaction messages. If the count is more than the limit within the window, the bridge treats this as a definite fault. The default limit is three messages in five minutes.

8.5.3 The bridge acts on this fault at once. The bridge does not wait for the silence timer, because the process is still busy and the silence timer would never start.

8.6 The hard ceiling.

8.6.1 The hard ceiling is a last-resort limit on the length of one turn. It covers the fault that the first two detectors cannot see: a process that gives activity without end and is wrong at the same time. Such a process resets the silence timer forever and can do this without a compaction message.

8.6.2 The ceiling acts in three stages. Each stage does more than the stage before it. The bridge does not go to a later stage if an earlier stage works. The reason for the stages is that the ceiling, unlike the other two detectors, can fire on a process that is fully healthy and only slow.

8.6.3 Stage one is the checkpoint. At the ceiling time the bridge speaks. The bridge says how long the turn has run. The bridge asks for the agreement word of 10.2.

8.6.4 If Chris says the agreement word within the checkpoint window, the turn continues for one more ceiling time. This can repeat without a limit. Each extension spends more tokens, so the bridge reports the usage with each checkpoint.

8.6.5 Stage two is the interrupt. If the bridge does not hear the agreement word within the checkpoint window, the bridge interrupts the turn. The bridge does not stop the process. The conversation, the context and the session stay.

8.6.6 The interrupt fails closed, as 10.5 requires. Fail closed is correct here because the cost of a wrong interrupt is low: the session stays, and Chris asks again in the next turn.

8.6.7 Stage three is the restart. After the interrupt the bridge waits for the process to be ready for a new turn. If the process is not ready within the grace time, the interrupt did not work and the process is wedged. The bridge then restarts the process.

8.6.8 A restart at the ceiling is safe because actions are atomic and the bridge commits before a risky step.

8.6.9 The default ceiling time is ten minutes. The default checkpoint window is fifteen seconds. The default grace time is thirty seconds. Each of the three is a setting.

8.6.10 The ceiling timer measures one turn. A new turn starts the timer again.

8.6.11 The ceiling is the unattended backstop. Chris ends a turn himself at any time with the command of 9.4.8. The ceiling exists for the case where Chris is not listening.

8.7 The process-memory recycle.

8.7.1 Some versions of Claude Code have a memory leak that grows without limit. The bridge watches the process memory size.

8.7.2 The bridge recycles the process when it passes the limit. The default limit is four gigabytes. On a sixty-four-gigabyte machine this is about eight to ten times a healthy footprint, so it is a clear sign of a leak and not normal work.

8.7.3 This is process memory, not context. The two are separate. A recycle is a planned restart, not only a restart after a crash.

8.8 The bridge lets Chris clear the context with a spoken command.

8.9 The bridge cannot read the remaining context from Claude Code, because Claude Code does not expose this number (see Section 16). The bridge makes a cheap best-guess estimate instead. The bridge counts the tokens it sends and watches for the compaction message. The bridge gives a soft warning when the estimate gets high and a definite warning when it sees a compaction.

8.10 The bridge lets Chris select the model with a spoken command.

8.11 The default model is Sonnet. This default is final. The model is a setting.

## 9. VOICE COMMANDS

9.1 A voice command starts with a wake word. The wake word separates a command from normal speech.

9.2 The wake word is "hey bridge". The wake word is a setting.

9.3 The bridge matches the sound of the wake word, not the exact spelling. A speech-to-text engine can split or spell the wake word in more than one way. The bridge accepts these forms.

9.4 The bridge does the commands that follow:

9.4.1 Mute. The bridge stops acting on speech. The bridge continues to listen for wake commands.

9.4.2 Unmute. The bridge acts on speech again.

9.4.3 Clear the context.

9.4.4 Report the usage.

9.4.5 Restate the last answer.

9.4.6 Summarize the last answer.

9.4.7 Report where we are. The bridge gives a short summary of the last three request and reply pairs. Chris uses this to reorient if something feels wrong.

9.4.8 End the turn. Chris uses this command if the automatic detection is wrong.

9.5 Two commands work when the bridge is muted. The two commands are mute and unmute. All other commands do not work when the bridge is muted.

9.6 The set of commands that work when muted is a setting. The set is a list of command names. Chris adds a command to the list later without a change to the code.

9.7 If the bridge hears only a part of a command, the bridge asks Chris to say the command again.

## 10. GATED ACTIONS

10.1 A gated action needs a spoken agreement before the bridge does it.

10.2 The agreement word is "continue". The agreement word is a setting. The agreement word is not "yes".

10.3 The reason is safety. A specific word cannot come from a reflex or a wrong transcription. This is like the callout that a pilot must say to override a limit.

10.4 Before a gated action, the bridge reads back what it is about to do.

10.5 The gate fails closed. If the bridge does not hear a clear agreement, the bridge does not do the action.

10.6 A gated action is atomic. An interruption does not leave the action half done.

## 11. INTERRUPTION AND TURN-TAKING

11.1 The bridge supports live barge-in. Chris can talk while the bridge speaks.

11.2 The bridge keeps the microphone open while it speaks.

11.3 The bridge stops its playback the moment Chris starts to talk.

11.4 The echo cancellation comes from LiveKit (see 4.2). The bridge does not hear its own audio as speech. The hard case is double-talk, the moment when Chris and the bridge speak together, which is the barge-in moment. A proven framework handles this moment. A hand-built canceller does not.

11.5 The bridge uses automatic end-of-turn detection as the main method. A small pause is acceptable. The pause length is a setting.

11.6 The target feel is the Claude app voice mode. The bridge waits a short time. The bridge does not cut in. The bridge does not feel slow.

11.7 A non-verbal end-of-turn signal, for example a click sound, is an option for later.

11.8 The product is for one user. The product does not need to separate the voices of more than one person.

## 12. SECURITY

12.1 The bridge endpoint needs authentication. Authentication is the security boundary.

12.2 The client pairs with the bridge one time. The client keeps a long-lived token.

12.3 The same authentication method works for the web client and the Android app.

12.4 The method is easy to use. Chris does not log in again and again.

12.5 The bridge does not read secrets aloud.

12.6 The agent runs in a dev container with git work trees. This is the accepted practice for an unattended, permissive agent that has shell access. A work tree alone protects the main checkout but does not isolate the machine. The container isolates the file system and the processes.

## 13. COST CONTROL

13.1 A warm session can spend tokens quickly.

13.2 The bridge gives a spoken warning about usage. The warning level is a setting.

13.3 Chris can ask for the usage with a spoken command.

13.4 The compaction-loop detector (8.5) also protects cost, because a compaction loop spends tokens fast.

13.5 The hard ceiling (8.6) bounds the cost of one turn in the worst case. A turn only runs past the ceiling if Chris says the agreement word, and the bridge reports the usage each time it asks.

13.6 The local speech engine has no per-use cost.

## 14. RESILIENCE AND SYNCHRONIZATION

14.1 The connection in a car is not stable. The connection drops. The connection gets weak. The connection moves between towers.

14.2 LiveKit handles the reconnection of the transport. The bridge handles the session state on top of this.

14.3 The bridge does not lose the session because of a connection problem.

14.4 The bridge does not do an action two times because of a connection problem.

14.5 The bridge gives each turn a number. A recovery command is then not ambiguous.

14.6 The bridge tells the difference between a finished turn and a stalled turn. Restate replays a finished turn. Resume continues a stalled turn.

14.7 The client keeps a light text transcript. The transcript is a summary of the turns. The transcript is a fallback when the audio stalls. The transcript is also an audit trail.

14.8 The client gets the missed turns after it connects again.

## 15. AUDIBLE STATE

15.1 The bridge does not leave silence when it cannot answer. Silence is ambiguous.

15.2 The bridge plays a gentle audio cue when it is busy, for example when it does a cold start, when it restarts, or when it connects again.

15.3 The audio cue is like a telephone hold sound. The cue tells Chris that the bridge is still connected.

15.4 Different states can have different cues. Chris can then tell the states apart without words.

15.5 The bridge does not play a cue every time Chris waits. The bridge plays a cue only after a set delay. The delay is a setting.

15.6 The audio cue is pleasant and calm.

## 16. LESSONS FROM PRIOR ART

16.1 Other projects do voice for the Claude command-line tool. The nearest is claude-voice, which does speech-to-text, then the Claude command-line tool, then text-to-speech, with barge-in and a phone client. The telephony project claude-phone is the call-based method that this product does not use. Other projects are Happy Coder, Paseo, VoiceMode, and Voicebox. Learn from these projects. Read their code for the plumbing. Do not adopt one as the product. None of them do the gating, the wake commands, the car resilience, or the aleph memory split that this product needs.

16.2 Claude Code does not expose the remaining context to any outside tool. The bridge cannot read this number. This is the reason for the best-guess estimate in 8.9.

16.3 Auto-compaction can thrash. The context can refill at once after a compaction, and the loop repeats. This is the reason for the compaction-loop detector in 8.5.

16.4 Some versions of Claude Code have a memory leak that grows without limit and can use all the memory of the machine. This is the reason for the process-memory recycle in 8.7.

16.5 The metric that matters for speed is the time to the first audio, measured from the phone. The backend completion time is not the right metric. There is no portable number. Set a target from the real setup (see Section 18).

## 17. THE ANDROID APP

17.1 The app is private. Chris installs the app by side-load. Chris does not publish the app.

17.2 The app supports screen-off voice. The app uses a foreground service.

17.3 The app uses the LiveKit Android SDK. The transport and the echo cancellation are the same as the web client.

17.4 The echo cancellation on native Android can behave differently than in the browser, because the browser ships its own tuned cancellation. Test the barge-in quality in the car with the app, because this is the hardest setup to predict.

17.5 Lock-screen controls are a nice-to-have. The decision waits until the design of the app in 7.5. Do not decide this before that point.

17.6 A web page cannot keep the microphone open when the screen is locked. This is the reason for the app.

17.7 The app is the final method that removes the screen-on limit from 2.4.

## 18. MEASUREMENTS TO MAKE

18.1 No measurement blocks the build. Make each measurement during the build. Change a setting from Section 21 with the result.

18.2 Measure the end-of-turn detection time. Measure this time separately from the round-trip time. The result sets the pause length in 11.5.

18.3 The round-trip time is the network time plus the generation time.

18.4 Measure the time to the first audio from the phone. Record a middle value and a high value across many turns.

18.5 The speed numbers in the earlier plan came from a different machine, a cloud sandbox, a small model, and a one-line prompt. The numbers are the right shape but they are not a promise. Confirm the speed numbers on Chris's machine.

18.6 Confirm what a phone microphone can do in a moving car with the screen on. This measurement comes at 7.4, because the web client is the first client either way. If the result is bad, move the app of 7.5 forward.

18.7 Watch the memory size of the Claude Code process over a long session. This confirms the recycle limit in 8.7.

18.8 Test the wake word in live use. Do not test the wake word before the build. If "hey bridge" collides with normal conversation, change the setting in Section 21.

## 19. POINT STATUS

19.1 Muted command subset. Mute and unmute only. The set is a list in the settings, so Chris adds more later. See 9.5 and 9.6.

19.2 Default model. Sonnet. This is final. The model stays a setting. See 8.11.

19.3 Lock-screen controls. Deferred to the design of the app. See 17.5.

19.4 Turn limit. Two separate limits, not one. The silence limit is one minute of no output on any channel; a busy turn does not trip it. The hard ceiling is a separate limit on turn length, set at ten minutes, and it escalates: it speaks and asks, then interrupts the turn, then restarts the process only if the interrupt does not work. See 8.4 and 8.6.

19.5 Text-to-speech voice. Take the first working local voice. Do not wait for a decision. The engine is replaceable and the voice is a setting, but each replacement is also local: the voice path is local only, with no cloud engine and no cloud fallback. See 4.5 and 4.8.

19.6 Wake word. "hey bridge". Test it in live use, not in a separate test before the build. See 18.8.

## 20. TWO CHEAP TESTS BEFORE THE BUILD

20.1 The first test takes one minute. In a plain chat on the phone, not inside a project, ask what is in the memory about the Claude Code setup. If the chat reads back a real file, then the memory of Claude already works across surfaces. This test passed.

20.2 The second test takes two hours at the desk. Install a desktop voice tool. Hold a real spoken conversation with Claude Code. This shows how bad read-aloud code is. This shapes the instruction that stops it.

## 21. CONFIGURATION

21.1 The bridge reads one settings file. The bridge does not need a rebuild for a change to a setting.

21.2 Each setting has the default that follows. A default is a start value, not a fixed value.

| Setting | Default | Section |
| --- | --- | --- |
| Silence time before a restart | 1 minute | 8.4.3 |
| Hard ceiling for a turn | 10 minutes | 8.6.9 |
| Checkpoint window at the ceiling | 15 seconds | 8.6.9 |
| Grace time before a restart | 30 seconds | 8.6.9 |
| Compaction-loop limit | 3 messages | 8.5.2 |
| Compaction-loop window | 5 minutes | 8.5.2 |
| Process-memory recycle limit | 4 gigabytes | 8.7.2 |
| Context warning level | soft, then on compaction | 8.9 |
| Model | Sonnet | 8.11 |
| Wake word | "hey bridge" | 9.2 |
| Commands that work when muted | mute, unmute | 9.5 |
| Agreement word | "continue" | 10.2 |
| Gated action list | to set at 7.2 | 10.1 |
| End-of-turn pause | to set at 18.2 | 11.5 |
| Usage warning level | to set at 7.3 | 13.2 |
| Audio cue delay | to set at 7.3 | 15.5 |
| GPU budget for the voice path | 8 gigabytes, the whole GPU | 4.10 |
| Speech-to-text engine and model | small Whisper-family, local only | 4.6 |
| Text-to-speech engine and voice | first working local voice, local only | 4.9 |
| Project directory list | none, any directory | 6.1 |

21.3 A setting with the value "to set at" gets its first value at the build step named. The builder does not wait for this value before that step.

21.4 A new setting follows the same rule. A value that a builder wants to change during a test is a setting, not a constant.
