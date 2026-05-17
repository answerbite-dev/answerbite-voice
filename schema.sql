-- AnswerBite Database Schema
-- Run this in your Supabase SQL Editor

-- ═══════════════════════════════════════════════════════════════
-- RESTAURANTS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE restaurants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  cuisine TEXT,
  owner_id UUID REFERENCES auth.users(id),
  greeting TEXT DEFAULT 'Thank you for calling! How can I help you today?',
  voice_style TEXT DEFAULT 'friendly',
  can_take_orders BOOLEAN DEFAULT true,
  can_book_reservations BOOLEAN DEFAULT true,
  can_transfer BOOLEAN DEFAULT true,
  transfer_number TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- BUSINESS HOURS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE business_hours (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun, 6=Sat
  open_time TIME,
  close_time TIME,
  is_closed BOOLEAN DEFAULT false
);

-- ═══════════════════════════════════════════════════════════════
-- MENU ITEMS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE menu_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  category TEXT DEFAULT 'General',
  description TEXT,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- CALLS - Every inbound call logged here
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  caller_number TEXT,
  caller_name TEXT,
  call_type TEXT CHECK (call_type IN ('order', 'reservation', 'faq', 'transfer', 'missed', 'other')),
  status TEXT CHECK (status IN ('completed', 'booked', 'answered', 'transferred', 'missed', 'in_progress')) DEFAULT 'in_progress',
  summary TEXT, -- AI-generated summary of the call
  transcript JSONB, -- Full conversation transcript [{role, content, timestamp}]
  duration_seconds INT,
  recording_url TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════
-- ORDERS - Phone orders placed through AI agent
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_phone TEXT,
  customer_name TEXT,
  items JSONB NOT NULL, -- [{name, qty, price, notes}]
  subtotal DECIMAL(10,2),
  tax DECIMAL(10,2),
  total DECIMAL(10,2),
  order_type TEXT CHECK (order_type IN ('pickup', 'delivery')) DEFAULT 'pickup',
  status TEXT CHECK (status IN ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled')) DEFAULT 'pending',
  special_instructions TEXT,
  estimated_ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- RESERVATIONS - Bookings made through AI agent
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE reservations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_phone TEXT,
  customer_name TEXT,
  party_size INT NOT NULL,
  reservation_date DATE NOT NULL,
  reservation_time TIME NOT NULL,
  special_requests TEXT,
  status TEXT CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')) DEFAULT 'confirmed',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES for performance
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX idx_calls_restaurant ON calls(restaurant_id);
CREATE INDEX idx_calls_started ON calls(started_at DESC);
CREATE INDEX idx_calls_status ON calls(status);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_reservations_restaurant ON reservations(restaurant_id);
CREATE INDEX idx_reservations_date ON reservations(reservation_date);
CREATE INDEX idx_menu_restaurant ON menu_items(restaurant_id);

-- ═══════════════════════════════════════════════════════════════
-- Enable Row Level Security
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- Policies: owners see only their restaurant data
CREATE POLICY "Users see own restaurants" ON restaurants
  FOR ALL USING (owner_id = auth.uid());

CREATE POLICY "Users see own hours" ON business_hours
  FOR ALL USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_id = auth.uid()));

CREATE POLICY "Users see own menu" ON menu_items
  FOR ALL USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_id = auth.uid()));

CREATE POLICY "Users see own calls" ON calls
  FOR ALL USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_id = auth.uid()));

CREATE POLICY "Users see own orders" ON orders
  FOR ALL USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_id = auth.uid()));

CREATE POLICY "Users see own reservations" ON reservations
  FOR ALL USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_id = auth.uid()));

-- Service role can do everything (for the voice backend)
CREATE POLICY "Service role full access restaurants" ON restaurants
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access calls" ON calls
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access orders" ON orders
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access reservations" ON reservations
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access menu" ON menu_items
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access hours" ON business_hours
  FOR ALL USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- Enable Realtime for live dashboard updates
-- ═══════════════════════════════════════════════════════════════
ALTER PUBLICATION supabase_realtime ADD TABLE calls;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE reservations;

-- ═══════════════════════════════════════════════════════════════
-- SEED: Tony's Pizza test store
-- ═══════════════════════════════════════════════════════════════
INSERT INTO restaurants (id, name, address, phone, cuisine, greeting, voice_style)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Tony''s Pizza',
  '742 Evergreen Terrace, Detroit, MI 48201',
  '(313) 555-0100',
  'Pizza',
  'Thank you for calling Tony''s Pizza! How can I help you today?',
  'friendly'
);

-- Tony's hours
INSERT INTO business_hours (restaurant_id, day_of_week, open_time, close_time, is_closed) VALUES
  ('00000000-0000-0000-0000-000000000001', 0, '12:00', '22:00', false), -- Sun
  ('00000000-0000-0000-0000-000000000001', 1, '11:00', '22:00', false), -- Mon
  ('00000000-0000-0000-0000-000000000001', 2, '11:00', '22:00', false),
  ('00000000-0000-0000-0000-000000000001', 3, '11:00', '22:00', false),
  ('00000000-0000-0000-0000-000000000001', 4, '11:00', '22:00', false),
  ('00000000-0000-0000-0000-000000000001', 5, '11:00', '23:00', false), -- Fri
  ('00000000-0000-0000-0000-000000000001', 6, '11:00', '23:00', false); -- Sat

-- Tony's menu
INSERT INTO menu_items (restaurant_id, name, price, category) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Margherita Pizza', 12.99, 'Pizzas'),
  ('00000000-0000-0000-0000-000000000001', 'Pepperoni Pizza', 14.99, 'Pizzas'),
  ('00000000-0000-0000-0000-000000000001', 'BBQ Chicken Pizza', 16.99, 'Pizzas'),
  ('00000000-0000-0000-0000-000000000001', 'Hawaiian Pizza', 15.99, 'Pizzas'),
  ('00000000-0000-0000-0000-000000000001', 'Meat Lovers Pizza', 17.99, 'Pizzas'),
  ('00000000-0000-0000-0000-000000000001', 'Veggie Supreme Pizza', 15.99, 'Pizzas'),
  ('00000000-0000-0000-0000-000000000001', 'Garlic Knots (6pc)', 5.99, 'Sides'),
  ('00000000-0000-0000-0000-000000000001', 'Caesar Salad', 8.99, 'Sides'),
  ('00000000-0000-0000-0000-000000000001', 'Buffalo Wings (10pc)', 11.99, 'Sides'),
  ('00000000-0000-0000-0000-000000000001', 'Mozzarella Sticks (6pc)', 7.99, 'Sides'),
  ('00000000-0000-0000-0000-000000000001', 'Tiramisu', 7.99, 'Desserts'),
  ('00000000-0000-0000-0000-000000000001', 'Cannoli', 4.99, 'Desserts'),
  ('00000000-0000-0000-0000-000000000001', 'New York Cheesecake', 6.99, 'Desserts'),
  ('00000000-0000-0000-0000-000000000001', '2L Coca-Cola', 3.99, 'Drinks'),
  ('00000000-0000-0000-0000-000000000001', '2L Sprite', 3.99, 'Drinks'),
  ('00000000-0000-0000-0000-000000000001', 'Sparkling Water', 2.49, 'Drinks'),
  ('00000000-0000-0000-0000-000000000001', 'Iced Tea', 2.99, 'Drinks');
