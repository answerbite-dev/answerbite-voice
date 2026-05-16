/**
 * Handles incoming call webhooks from the SIP media server (FreeSWITCH/Asterisk)
 * Creates a call record in Supabase and returns the restaurant's greeting
 */

const { createAgent } = require("./agent");

async function handleCallWebhook(body, supabase) {
  const {
    caller_number,
    caller_name,
    called_number,
    restaurant_id,
  } = body;

  // Find restaurant by ID or by phone number
  let restaurant;
  if (restaurant_id) {
    const { data } = await supabase
      .from("restaurants")
      .select("*, menu_items(*), business_hours(*)")
      .eq("id", restaurant_id)
      .single();
    restaurant = data;
  } else if (called_number) {
    // Match by the number that was called
    const cleaned = called_number.replace(/\D/g, "").slice(-10);
    const { data } = await supabase
      .from("restaurants")
      .select("*, menu_items(*), business_hours(*)")
      .ilike("phone", `%${cleaned}%`)
      .single();
    restaurant = data;
  }

  if (!restaurant) {
    // Fallback to default test restaurant
    const { data } = await supabase
      .from("restaurants")
      .select("*, menu_items(*), business_hours(*)")
      .eq("id", process.env.DEFAULT_RESTAURANT_ID || "00000000-0000-0000-0000-000000000001")
      .single();
    restaurant = data;
  }

  if (!restaurant) {
    return {
      error: "No restaurant found",
      greeting: "I'm sorry, this number is not currently set up.",
    };
  }

  // Create the call record
  const { data: call, error } = await supabase
    .from("calls")
    .insert({
      restaurant_id: restaurant.id,
      caller_number: caller_number || "Unknown",
      caller_name: caller_name || null,
      status: "in_progress",
      transcript: [],
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to create call record:", error);
    return { error: "Database error" };
  }

  // Check if restaurant is currently open
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

  const todayHours = restaurant.business_hours?.find(
    (h) => h.day_of_week === dayOfWeek
  );

  let isOpen = true;
  let closedMessage = "";
  if (todayHours?.is_closed) {
    isOpen = false;
    closedMessage = `I'm sorry, ${restaurant.name} is closed today. `;
  } else if (todayHours && (currentTime < todayHours.open_time || currentTime > todayHours.close_time)) {
    isOpen = false;
    closedMessage = `I'm sorry, ${restaurant.name} is currently closed. Our hours today are ${todayHours.open_time} to ${todayHours.close_time}. `;
  }

  // Build greeting
  let greeting = restaurant.greeting || `Thank you for calling ${restaurant.name}! How can I help you?`;
  if (!isOpen) {
    greeting = closedMessage + "You can still place an order for when we open, or I can help with other questions.";
  }

  return {
    call_id: call.id,
    restaurant_id: restaurant.id,
    greeting,
    is_open: isOpen,
    restaurant_name: restaurant.name,
  };
}

module.exports = { handleCallWebhook };
