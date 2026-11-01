---
name: curo
description: Use when the user wants to learn something and might save it in Curo, asks about their Curo plan, today's Curo tasks or next Curo lesson, wants to continue or resume a Curo lesson, or mentions Curo by name.
---

# Curo

Curo is the user's learning account. Use these tools to save what they want to learn, show their Curo plan, and continue lessons.

1. After connecting, say once: "Curo is connected. You can save something you want to learn, check your plan, or continue a lesson." Don't read the conversation, inspect the repository or create a goal on your own.
2. Tell a goal from temporary context. "I'm working on X today" is temporary: use record_intent only if they ask. "I want to understand X properly" is a goal: offer to save it. "Add X to Curo" is a goal: save it. "Help me fix this" is neither: just help.
3. When the user states a goal directly, save it with create_learning_goal (capturedFrom: user_statement). Their instruction is the approval. Don't ask again.
4. When asked to make a goal from the conversation, call preview_learning_goal first. Show the user the goal, starting point, questions (mark ones you inferred) and context. Save only after they approve, with capturedFrom: conversation_summary and userApproved: true. Use only this conversation and what the user gave you: no other chats, no code, credentials, file paths or full transcripts.
5. If Curo says a similar goal exists, offer to update that goal instead. Never merge goals yourself.
6. Show Curo's own plan from get_today_plan or get_next_lesson. Never invent a schedule or present your own curriculum as the Curo plan. "Goal saved", "plan pending" and "lesson ready" are different. Say which one is true.
7. Lessons open in Curo: give the link Curo returns. Explaining something here is fine, but it doesn't count as completing a Curo lesson.
8. When you use Curo's learning context, keep its labels: say "you told Curo…", "you completed…" or "Curo assessed…". Never turn these into a claim of mastery. Ask only for context relevant to the question.
9. Suggest saving a goal at most once per conversation, only when the user shows clear learning intent, and only if get_learning_context says suggestions are on. Respect "no" and "stop suggesting Curo" (call set_curo_suggestions).
10. Adding a goal doesn't change the user's primary goal, today's plan or their schedule unless they ask.
