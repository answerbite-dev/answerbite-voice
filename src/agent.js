const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'placeholder' });

function createAgent(restaurant) {
  // Build the restaurant context for the system prompt
  const menuText = (restaurant.menu_items || [])
    .map((item) => `- ${item.name}: $${item.price} (${item.category})`)
    .join("\n");

  const hoursText = (restaurant.business_hours || [])
    .sort((a, b) => a.day_of_week - b.day_of_week)
    .map((h) => {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      if (h.is_closed) return `${days[h.day_of_week]}: Closed`;
      return `${days[h.day_of_week]}: ${h.open_time} - ${h.close_time}`;
    })
    .join("\n");

  const systemPrompt = `You are an AI phone receptionist for ${restaurant.name || "a restaurant"}.
Your voice style is: ${restaurant.voice_style || "friendly"}
Your greeting: "${restaurant.greeting || "Thank you for calling! How can I help you?"}"

RESTAURANT INFO:
- Name: ${restaurant.name || "Restaurant"}
- Address: ${restaurant.address || "Not available"}
- Phone: ${restaurant.phone || "Not available"}
- Cuisine: ${restaurant.cuisine || "General"}

BUSINESS HOURS:
${hoursText || "Not set"}

MENU:
${menuText || "Not available"}

CAPABILITIES:
- Take orders: ${restaurant.can_take_orders !== false ? "YES" : "NO"}
- Book reservations: ${restaurant.can_book_reservations !== false ? "YES" : "NO"}
- Transfer calls: ${restaurant.can_transfer !== false ? "YES" : "NO"}

INSTRUCTIONS:
1. Be warm, natural, and conversational. Sound like a real person, not a robot.
2. Keep responses SHORT — 1-3 sentences max. This is a phone call, not an essay.
3. When taking an order, confirm each item and the total before finalizing.
4. When booking a reservation, get: name, party size, date, time, and any special requests.
5. If you can't help with something, offer to transfer to a staff member.
6. If the caller asks about something not on the menu, politely let them know.
7. Always be helpful about dietary questions (gluten-free, vegan, allergies).

RESPONSE FORMAT:
Respond with a JSON object ONLY. No other text. The JSON must have:
{
  "text": "What you say to the caller",
  "action": null | "place_order" | "book_reservation" | "transfer" | "end_call",
  "order": null | { "items": [...], "subtotal": X, "tax": X, "total": X, "customer_name": "", "customer_phone": "", "order_type": "pickup|delivery", "special_instructions": "" },
  "reservation": null | { "customer_name": "", "customer_phone": "", "party_size": X, "date": "YYYY-MM-DD", "time": "HH:MM", "special_requests": "" }
}

Only include "order" when the order is FULLY CONFIRMED by the caller.
Only include "reservation" when the reservation is FULLY CONFIRMED.
Set action to "end_call" when the conversation is naturally ending.
Set action to "transfer" when the caller wants to speak to a human.`;

  return {
    async respond(callerText, conversationHistory) {
      const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory.map((msg) => ({
          role: msg.role === "caller" ? "user" : "assistant",
          content: msg.role === "agent" ? msg.content : msg.content,
        })),
        { role: "user", content: callerText },
      ];

      try {
        const completion = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages,
          temperature: 0.7,
          max_tokens: 500,
          response_format: { type: "json_object" },
        });

        const raw = completion.choices[0]?.message?.content || "";
        const parsed = JSON.parse(raw);
        return {
          text: parsed.text || "I'm sorry, could you repeat that?",
          action: parsed.action || null,
          order: parsed.order || null,
          reservation: parsed.reservation || null,
        };
      } catch (err) {
        console.error("Groq error:", err);
        return {
          text: "I'm sorry, I'm having a little trouble right now. Can you repeat that?",
          action: null,
          order: null,
          reservation: null,
        };
      }
    },

    async classifyCall(transcript) {
      if (!transcript || transcript.length === 0) {
        return { type: "missed", status: "missed", summary: "No conversation recorded" };
      }

      const convoText = transcript
        .map((t) => `${t.role}: ${t.content}`)
        .join("\n");

      try {
        const completion = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: `Classify this restaurant phone call. Respond with JSON only:
{
  "type": "order" | "reservation" | "faq" | "transfer" | "other",
  "status": "completed" | "booked" | "answered" | "transferred" | "missed",
  "summary": "One sentence summary of what happened"
}`,
            },
            { role: "user", content: convoText },
          ],
          temperature: 0.3,
          max_tokens: 200,
          response_format: { type: "json_object" },
        });

        return JSON.parse(completion.choices[0]?.message?.content || "{}");
      } catch {
        return { type: "other", status: "completed", summary: "Call completed" };
      }
    },
  };
}

module.exports = { createAgent };
