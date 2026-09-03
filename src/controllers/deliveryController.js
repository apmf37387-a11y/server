const Order = require('../models/Order');
const Product = require('../models/Product');
const Deal = require('../models/Deal');
const Inventory = require('../models/Inventory');
const ColdDrink = require('../models/Colddrink');
const { generateOrderNumber, calculateTotalTime, calculateOrderTotal } = require('../utils/helpers');
const { getSystemSettings } = require('../utils/systemSettings');
const { deductFoodIngredientsForOrder, deductColdDrinksForOrder } = require('../utils/inventoryDeduction');

// ─── Helper ───────────────────────────────────────────────────────────────────
const resolveItemType = (item) => {
  if (item.itemType) return item.itemType;
  if (item.type === 'cold_drink') return 'Inventory';
  if (item.type === 'deal') return 'Deal';
  return 'Product';
};

// ========== MENU ==========

exports.getMenu = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const now = new Date();

    const products = await Product.find({ branchId, isAvailable: true })
      .populate('sizes.ingredients.inventoryItemId', 'name currentStock unit')
      .lean();

    // ✅ FIX: Waiter jaise sirf isActive check — koi date filter nahi
    const rawDeals = await Deal.find({ branchId, isActive: true })
      .populate('products.productId', 'name image')
      .lean();

    const deals = rawDeals.map(d => ({ ...d, price: d.discountedPrice }));

    const rawColdDrinks = await ColdDrink.find({ branchId, isActive: true }).lean();

    const coldDrinks = rawColdDrinks
      .map(d => ({
        _id: d._id,
        name: d.name,
        company: d.company,
        description: d.company,
        category: 'cold_drinks',
        sizes: d.sizes
          .filter(s => s.currentStock > 0 && (!s.expiryDate || new Date(s.expiryDate) > now))
          .map(s => ({
            _id: s._id,
            size: s.size,
            price: s.salePrice,
            currentStock: s.currentStock,
          })),
      }))
      .filter(d => d.sizes.length > 0);

    res.json({
      success: true,
      menu: { products, deals, coldDrinks },
      counts: { products: products.length, deals: deals.length, coldDrinks: coldDrinks.length },
    });
  } catch (error) {
    console.error('Get delivery menu error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== CREATE DELIVERY ORDER ==========

exports.createDeliveryOrder = async (req, res) => {
  try {
    const {
      items, customerName, customerPhone,
      deliveryAddress, notes, orderType = 'delivery',
    } = req.body;

    if (!customerName || !customerPhone)
      return res.status(400).json({ success: false, message: 'Customer name aur phone zaroori hain' });
    if (orderType === 'delivery' && !deliveryAddress)
      return res.status(400).json({ success: false, message: 'Delivery address zaroori hai' });
    if (!items || items.length === 0)
      return res.status(400).json({ success: false, message: 'Kam se kam ek item hona chahiye' });

    const branchId = req.user.branchId;

    // ── System settings ────────────────────────────────────────────────────
    const { kitchenSystemEnabled, barmanSystemEnabled } = await getSystemSettings(branchId);

    const processedItems = items.map(item => ({
      ...item,
      itemType: item.itemType || (item.type === 'cold_drink' ? 'Inventory' : item.type === 'deal' ? 'Deal' : 'Product'),
    }));

    // Stock check for cold drinks
    for (const item of processedItems) {
      if (item.type === 'cold_drink') {
        try {
          const coldDrink = await ColdDrink.findOne({ 'sizes._id': item.itemId });
          if (coldDrink) {
            const sizeVariant = coldDrink.sizes.id(item.itemId);
            if (sizeVariant && sizeVariant.currentStock < item.quantity)
              return res.status(400).json({ success: false, message: `Insufficient stock: ${coldDrink.name} (${sizeVariant.size})` });
          }
        } catch { }
      }
    }

    const { subtotal, tax, total } = calculateOrderTotal(processedItems, 0, 0);
    const estimatedTime = calculateTotalTime(processedItems) + (orderType === 'takeaway' ? 10 : 20);

    const hasColdDrinksInOrder = processedItems.some(i => i.isColdDrink || i.type === 'cold_drink');

    // ── Initial states based on system settings ────────────────────────────
    const initialStatus = kitchenSystemEnabled ? 'pending' : 'ready';
    const initialStockDed = !kitchenSystemEnabled;
    const coldDrinksStatus = (!hasColdDrinksInOrder || !barmanSystemEnabled)
      ? 'delivered'
      : 'pending';

    let cashierNote = orderType === 'takeaway'
      ? `🥡 Takeaway — ${customerName} | ${customerPhone}`
      : `🚚 Delivery — ${customerName} | ${customerPhone}`;

    const isCreatorDeliveryBoy = req.user.role === 'delivery';

    const orderData = {
      orderNumber: await generateOrderNumber(),
      branchId,
      orderType,
      items: processedItems,
      subtotal, tax, total, estimatedTime,
      deliveryBoyId: isCreatorDeliveryBoy ? req.user._id : null,   // ✅
      waiterId: !isCreatorDeliveryBoy ? req.user._id : undefined,  // ✅ optional: track who created it
      customerName, customerPhone, notes, cashierNote,
      status: initialStatus,
      stockDeducted: initialStockDed,
      hasColdDrinks: hasColdDrinksInOrder,
      coldDrinksStatus,
    };
    if (orderType === 'delivery' && deliveryAddress) orderData.deliveryAddress = deliveryAddress;

    const order = await Order.create(orderData);

    // ── Deduct immediately if systems are OFF ──────────────────────────────
    if (!kitchenSystemEnabled) {
      await deductFoodIngredientsForOrder(processedItems);
    }
    if (hasColdDrinksInOrder && !barmanSystemEnabled) {
      await deductColdDrinksForOrder(processedItems);
    }

    const populatedOrder = await Order.findById(order._id)
      .populate('deliveryBoyId', 'name phone')
      .populate('items.itemId', 'name');

    const io = req.app.get('io');
    if (io && hasColdDrinksInOrder && barmanSystemEnabled) {
      io.to(`branch-${String(branchId)}`).emit('new-colddrink-order', {
        orderId: String(order._id), orderNumber: order.orderNumber,
        orderType: order.orderType, total: order.total, customerName,
        coldDrinkItems: processedItems
          .filter(i => i.isColdDrink || i.type === 'cold_drink')
          .map(i => ({ name: i.name, size: i.size || null, quantity: i.quantity })),
        message: `🧃 New cold drink order #${order.orderNumber}`,
      });
    }

    res.status(201).json({
      success: true,
      order: populatedOrder,
      systemInfo: { kitchenSystemEnabled, barmanSystemEnabled },
      message: orderType === 'takeaway' ? '🥡 Takeaway order kitchen mein bhej diya!' : '🚚 Delivery order create ho gaya!',
    });
  } catch (error) {
    console.error('Create delivery order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== MY ORDERS ==========

exports.getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      deliveryBoyId: req.user._id,
      status: { $nin: ['completed', 'cancelled'] },
    })
      .populate('chefId', 'name')
      .populate('items.itemId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    console.error('Get my orders error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== GET UNASSIGNED ORDERS ==========

exports.getUnassignedOrders = async (req, res) => {
  try {
    const branchId = req.user.branchId;

    const orders = await Order.find({
      branchId,
      orderType: 'delivery',
      status: 'ready',
      deliveryBoyId: null,
    })
      .populate('waiterId', 'name')
      .populate('items.itemId', 'name')
      .sort({ readyAt: 1 })
      .lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    console.error('Get unassigned orders error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== CLAIM ORDER ==========

exports.claimOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        orderType: 'delivery',
        status: 'ready',
        deliveryBoyId: null,
        branchId: req.user.branchId,
      },
      { $set: { deliveryBoyId: req.user._id } },
      { new: true }
    )
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name phone')
      .populate('items.itemId', 'name');

    if (!order) {
      return res.status(409).json({
        success: false,
        message: 'Yeh order pehle hi kisi aur ne claim kar li ya available nahi hai',
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${req.user.branchId}`).emit('order-claimed', {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        claimedBy: req.user.name || 'Delivery Boy',
        claimedById: String(req.user._id),
      });
    }

    res.json({ success: true, order, message: `Order ${order.orderNumber} aapne claim kar li!` });
  } catch (error) {
    console.error('Claim order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { orderId, status, departureMeterReading } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (String(order.deliveryBoyId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (order.orderType === 'takeaway' && status === 'out_for_delivery') {
      return res.status(400).json({
        success: false,
        message: 'Takeaway orders ke liye /mark-delivered route use karein',
      });
    }

    order.status = status;

    if (status === 'out_for_delivery') {
      order.departedAt = new Date();
      if (departureMeterReading != null && !isNaN(Number(departureMeterReading))) {
        // ✅ Dono field names mein save karo
        order.departureMeterReading = parseFloat(departureMeterReading);
        order.startMeterReading = parseFloat(departureMeterReading); // legacy
        console.log(`✅ Departure saved: ${order.departureMeterReading} km | order: ${order.orderNumber}`);
      }
    }

    if (status === 'delivered') order.deliveredAt = new Date();

    await order.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${String(req.user.branchId)}`).emit('order-updated', {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        newStatus: status,
        departureMeterReading: order.departureMeterReading ?? null,
        message: `🚀 Order #${order.orderNumber} out for delivery`,
      });
    }

    const populatedOrder = await Order.findById(order._id)
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    res.json({ success: true, order: populatedOrder, message: `Status updated to ${status}` });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.completeDelivery = async (req, res) => {
  try {
    const { orderId, cashReceived, returnMeterReading } = req.body;

    if (!orderId || cashReceived === undefined || cashReceived === null) {
      return res.status(400).json({
        success: false,
        message: 'orderId and cashReceived are required',
      });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (String(order.deliveryBoyId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (order.status !== 'out_for_delivery') {
      return res.status(400).json({
        success: false,
        message: `Order must be out_for_delivery. Current: ${order.status}`,
      });
    }

    order.status = 'returned';
    order.cashReceived = parseFloat(cashReceived);
    order.returnedAt = new Date();

    // ✅ returnMeterReading save karo — dono field names mein (backward compat)
    if (returnMeterReading != null && !isNaN(Number(returnMeterReading))) {
      order.returnMeterReading = parseFloat(returnMeterReading);
      order.endMeterReading = parseFloat(returnMeterReading); // legacy field bhi

      // ✅ departureMeterReading dono field names se check karo
      const departure = order.departureMeterReading ?? order.startMeterReading ?? null;

      if (departure != null && order.returnMeterReading > departure) {
        order.distanceTravelled = parseFloat(
          (order.returnMeterReading - departure).toFixed(1)
        );
        console.log(`✅ KM: ${departure} → ${order.returnMeterReading} = ${order.distanceTravelled} km`);
      } else {
        order.distanceTravelled = 0;
        console.warn(`⚠️ distanceTravelled = 0 | departure: ${departure} | return: ${order.returnMeterReading}`);
      }
    }

    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    // ✅ Cashier ko socket push karo
    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${String(req.user.branchId)}`).emit('delivery-returned', {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        deliveryBoyName: req.user.name || 'Delivery Boy',
        cashReceived: order.cashReceived,
        orderTotal: order.total,
        change: order.cashReceived - order.total,
        departureMeterReading: order.departureMeterReading ?? order.startMeterReading ?? null,
        returnMeterReading: order.returnMeterReading ?? null,
        distanceTravelled: order.distanceTravelled ?? null,
        message: `🏠 Order #${order.orderNumber} wapas! Cash: Rs.${order.cashReceived}${order.distanceTravelled ? ` | ${order.distanceTravelled} km` : ''
          }`,
      });
    }

    res.json({
      success: true,
      order: populatedOrder,
      summary: {
        cashReceived: order.cashReceived,
        orderTotal: order.total,
        change: parseFloat(cashReceived) - order.total,
        departureMeterReading: order.departureMeterReading ?? order.startMeterReading ?? null,
        returnMeterReading: order.returnMeterReading ?? null,
        distanceTravelled: order.distanceTravelled ?? null,
      },
      message: `🏠 Wapas aa gaye!${order.distanceTravelled ? ` Distance: ${order.distanceTravelled} km` : ''
        } Cashier se payment verify karwaein.`,
    });
  } catch (error) {
    console.error('Complete delivery error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.requestPrint = async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // ✅ Verify delivery boy owns this order
    if (String(order.deliveryBoyId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Set printRequested flag — Cashier Desktop polls/listens for this
    order.printRequested = true;
    order.printRequestedAt = new Date();
    await order.save();

    // Emit socket event so Cashier Desktop prints immediately if online
    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${req.user.branchId}`).emit('print-request', {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        orderType: 'delivery',
        requestedBy: req.user.name || 'Delivery Boy',
      });
    }

    res.json({
      success: true,
      message: `Print request sent for order #${order.orderNumber}`,
    });
  } catch (error) {
    console.error('Request print error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== UPDATE ORDER (edit pending orders only) ==========

exports.updateOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const { items, customerName, customerPhone, deliveryAddress, notes } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (String(order.deliveryBoyId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update order after chef acceptance',
      });
    }

    if (items) {
      if (items.length === 0) {
        return res.status(400).json({ success: false, message: 'Order must have at least one item' });
      }
      const processedItems = items.map(item => ({ ...item, itemType: resolveItemType(item) }));
      const { subtotal, tax, total } = calculateOrderTotal(processedItems, order.discount, 0);
      order.items = processedItems;
      order.subtotal = subtotal;
      order.tax = tax;
      order.total = total;
      order.estimatedTime = calculateTotalTime(processedItems) + 20;
    }

    if (customerName) order.customerName = customerName;
    if (customerPhone) order.customerPhone = customerPhone;
    if (deliveryAddress) order.deliveryAddress = deliveryAddress;
    if (notes !== undefined) order.notes = notes;

    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    res.json({ success: true, order: populatedOrder, message: 'Order updated successfully' });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== DELIVERY HISTORY ==========

exports.getDeliveryHistory = async (req, res) => {
  try {
    const orders = await Order.find({
      deliveryBoyId: req.user._id,
      status: { $in: ['completed', 'returned', 'delivered', 'cancelled'] },
    })
      .populate('items.itemId', 'name')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    console.error('Get delivery history error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markDeliveredTakeaway = async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId); createDeliveryOrder
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Only delivery boy jo is order ka owner hai
    if (String(order.deliveryBoyId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Yeh aapki order nahi hai' });
    }

    // Sirf takeaway orders
    if (order.orderType !== 'takeaway') {
      return res.status(400).json({
        success: false,
        message: 'Yeh function sirf takeaway orders ke liye hai',
      });
    }

    // Sirf ready orders deliver ho sakti hain
    if (order.status !== 'ready') {
      return res.status(400).json({
        success: false,
        message: `Order sirf ready hone ke baad deliver ho sakti hai. Current status: ${order.status}`,
      });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    await order.save();

    // Notify cashier via socket
    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${req.user.branchId}`).emit('order-updated', {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        newStatus: 'delivered',
        orderType: 'takeaway',
        message: `🥡 Takeaway #${order.orderNumber} — Customer ko de diya. Payment pending.`,
      });
    }

    const populatedOrder = await Order.findById(order._id)
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    res.json({
      success: true,
      order: populatedOrder,
      message: `✅ Order #${order.orderNumber} delivered! Cashier payment receive karega.`,
    });
  } catch (error) {
    console.error('markDeliveredTakeaway error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.extractMeterReading = async (req, res) => {
  try {
    const { base64Image } = req.body;
    if (!base64Image) {
      return res.status(400).json({ success: false, reading: null, message: 'base64Image required' });
    }

    // ✅ Strip data URI prefix agar frontend ne bheja ho
    const cleanBase64 = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');

    // ✅ Size check — 10MB se zyada nahi
    const sizeBytes = (cleanBase64.length * 3) / 4;
    if (sizeBytes > 10 * 1024 * 1024) {
      return res.json({ success: false, reading: null, message: 'Image too large — enter manually' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({ success: false, reading: null, message: 'OCR not configured — enter manually' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // ✅ Haiku faster + cheaper for OCR
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: cleanBase64 },
            },
            {
              type: 'text',
              text: 'This is a bike odometer. Extract ONLY the total odometer/kilometer reading as a plain integer number. Return ONLY the digits, no units, no text, no explanation. Example response: 12345',
            },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.json({ success: false, reading: null, message: `OCR API error: ${response.status}` });
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text?.trim() || '';
    console.log('OCR raw response:', rawText);

    // ✅ Extract only digits
    const digitsOnly = rawText.replace(/[^0-9]/g, '');
    const numeric = parseFloat(digitsOnly);

    if (!digitsOnly || isNaN(numeric) || numeric <= 0) {
      return res.json({ success: false, reading: null, message: 'Could not extract reading — enter manually' });
    }

    res.json({ success: true, reading: numeric });
  } catch (error) {
    console.error('Extract meter reading error:', error);
    res.json({ success: false, reading: null, message: error.message });
  }
};

exports.getDeliveryBoyStats = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const now = new Date();

    // ── Shift window: 9:00 AM → 4:00 AM next day ──
    // Determine shift start: if current hour < 9, shift started yesterday
    let shiftStart = new Date(now);
    shiftStart.setHours(9, 0, 0, 0);

    if (now.getHours() < 9) {
      // Between midnight and 9 AM → shift started yesterday at 9 AM
      shiftStart.setDate(shiftStart.getDate() - 1);
    }

    const shiftEnd = new Date(shiftStart);
    shiftEnd.setDate(shiftEnd.getDate() + 1);
    shiftEnd.setHours(4, 0, 0, 0); // 4 AM next day

    // ── Only DELIVERY orders (not takeaway), within this shift ──
    const orders = await Order.find({
      branchId,
      orderType: { $in: ['delivery', null, undefined] }, // exclude takeaway
      $or: [{ orderType: 'delivery' }, { orderType: { $exists: false } }],
      createdAt: { $gte: shiftStart, $lte: shiftEnd },
      deliveryBoyId: { $ne: null },
    })
      .populate('deliveryBoyId', 'name phone')
      .lean();

    // ── Group stats by delivery boy ──
    const statsMap = {};
    for (const order of orders) {
      if (!order.deliveryBoyId) continue;
      // Extra guard: skip takeaway
      if (order.orderType === 'takeaway') continue;

      const dbId = String(order.deliveryBoyId._id || order.deliveryBoyId);
      if (!statsMap[dbId]) {
        statsMap[dbId] = {
          deliveryBoy: order.deliveryBoyId,
          totalOrders: 0,
          completedOrders: 0,
          activeOrders: 0,
          totalKm: 0,
          totalCashCollected: 0,
          ordersList: [],
        };
      }

      statsMap[dbId].totalOrders++;

      if (['completed', 'returned'].includes(order.status)) {
        statsMap[dbId].completedOrders++;
        statsMap[dbId].totalCashCollected += order.cashReceived || order.total || 0;
      } else if (!['cancelled'].includes(order.status)) {
        statsMap[dbId].activeOrders++;
      }

      if (order.distanceTravelled) {
        statsMap[dbId].totalKm = parseFloat(
          (statsMap[dbId].totalKm + order.distanceTravelled).toFixed(1)
        );
      }

      statsMap[dbId].ordersList.push({
        orderNumber: order.orderNumber,
        status: order.status,
        total: order.total,
        cashReceived: order.cashReceived,
        distanceTravelled: order.distanceTravelled,
        customerName: order.customerName,
        departureMeterReading: order.departureMeterReading,
        returnMeterReading: order.returnMeterReading,
        createdAt: order.createdAt,
      });
    }

    const stats = Object.values(statsMap).sort(
      (a, b) => b.completedOrders - a.completedOrders
    );

    res.json({
      success: true,
      shiftStart,
      shiftEnd,
      shiftLabel: `${shiftStart.toLocaleDateString('en-PK')} 9:00 AM — ${shiftEnd.toLocaleDateString('en-PK')} 4:00 AM`,
      stats,
      summary: {
        totalDeliveryOrders: orders.filter(o => o.orderType !== 'takeaway').length,
        totalDeliveryBoys: stats.length,
        totalKmAll: stats.reduce((s, d) => s + d.totalKm, 0).toFixed(1),
      },
    });
  } catch (error) {
    console.error('Get delivery boy stats error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.claimMultipleOrders = async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0)
      return res.status(400).json({ success: false, message: 'orderIds array zaroori hai' });

    const tripId = `TRIP-${Date.now()}-${req.user._id}`;

    const result = await Order.updateMany(
      {
        _id: { $in: orderIds },
        orderType: 'delivery',
        status: 'ready',
        deliveryBoyId: null,
        branchId: req.user.branchId,
      },
      { $set: { deliveryBoyId: req.user._id, deliveryTripId: tripId } }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).json({
        success: false,
        message: 'Yeh orders pehle hi claim ho chuki hain ya available nahi hain',
      });
    }

    const claimedOrders = await Order.find({ deliveryTripId: tripId, deliveryBoyId: req.user._id })
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name phone')
      .populate('items.itemId', 'name');

    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${req.user.branchId}`).emit('order-claimed', {
        orderIds: claimedOrders.map(o => String(o._id)),
        orderNumbers: claimedOrders.map(o => o.orderNumber),
        claimedBy: req.user.name || 'Delivery Boy',
        claimedById: String(req.user._id),
        tripId,
      });
    }

    const partial = result.modifiedCount < orderIds.length;

    res.json({
      success: true,
      orders: claimedOrders,
      tripId,
      message: partial
        ? `${claimedOrders.length} orders mil gayi — baaki koi aur claim kar chuka tha`
        : `${claimedOrders.length} orders aapne claim kar li!`,
    });
  } catch (error) {
    console.error('Claim multiple orders error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== STATUS UPDATE FOR MULTIPLE ORDERS (ek hi departure meter sab pe) ==========
exports.updateOrderStatusMultiple = async (req, res) => {
  try {
    const { orderIds, status, departureMeterReading } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0)
      return res.status(400).json({ success: false, message: 'orderIds array zaroori hai' });

    const owned = await Order.find({ _id: { $in: orderIds }, deliveryBoyId: req.user._id });
    if (owned.length !== orderIds.length)
      return res.status(403).json({ success: false, message: 'Kuch orders aapki nahi hain ya nahi milin' });

    const update = { status };
    if (status === 'out_for_delivery') {
      update.departedAt = new Date();
      if (departureMeterReading != null && !isNaN(Number(departureMeterReading))) {
        update.departureMeterReading = parseFloat(departureMeterReading);
        update.startMeterReading = parseFloat(departureMeterReading); // legacy
      }
    }
    if (status === 'delivered') update.deliveredAt = new Date();

    await Order.updateMany({ _id: { $in: orderIds } }, { $set: update });

    const populatedOrders = await Order.find({ _id: { $in: orderIds } })
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${String(req.user.branchId)}`).emit('order-updated', {
        orderIds,
        orderNumbers: populatedOrders.map(o => o.orderNumber),
        newStatus: status,
        departureMeterReading: update.departureMeterReading ?? null,
        message: `🚀 ${orderIds.length} orders out for delivery`,
      });
    }

    res.json({ success: true, orders: populatedOrders, message: `Status updated to ${status}` });
  } catch (error) {
    console.error('Update order status (multiple) error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== COMPLETE DELIVERY FOR MULTIPLE ORDERS (ek hi return meter sab pe) ==========
exports.completeDeliveryMultiple = async (req, res) => {
  try {
    const { orders: orderPayloads, returnMeterReading } = req.body;
    // orderPayloads: [{ orderId, cashReceived }, ...]  — cash har order ka alag ho sakta hai
    if (!Array.isArray(orderPayloads) || orderPayloads.length === 0)
      return res.status(400).json({ success: false, message: 'orders array zaroori hai' });
    if (returnMeterReading == null || isNaN(Number(returnMeterReading)))
      return res.status(400).json({ success: false, message: 'returnMeterReading zaroori hai' });

    const returnReading = parseFloat(returnMeterReading);
    const results = [];

    for (const { orderId, cashReceived } of orderPayloads) {
      if (cashReceived == null) continue;
      const order = await Order.findById(orderId);
      if (!order) continue;
      if (String(order.deliveryBoyId) !== String(req.user._id)) continue;
      if (order.status !== 'out_for_delivery') continue;

      order.status = 'returned';
      order.cashReceived = parseFloat(cashReceived);
      order.returnedAt = new Date();
      order.returnMeterReading = returnReading;
      order.endMeterReading = returnReading; // legacy

      const departure = order.departureMeterReading ?? order.startMeterReading ?? null;
      order.distanceTravelled = (departure != null && returnReading > departure)
        ? parseFloat((returnReading - departure).toFixed(1))
        : 0;

      await order.save();
      results.push(order);
    }

    if (results.length === 0)
      return res.status(400).json({ success: false, message: 'Koi order update nahi hui — status ya ownership check karein' });

    const populatedOrders = await Order.find({ _id: { $in: results.map(o => o._id) } })
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    const totalCash = results.reduce((s, o) => s + o.cashReceived, 0);
    const totalAmount = results.reduce((s, o) => s + o.total, 0);

    const io = req.app.get('io');
    if (io) {
      io.to(`branch-${String(req.user.branchId)}`).emit('delivery-returned', {
        orderIds: results.map(o => String(o._id)),
        orderNumbers: results.map(o => o.orderNumber),
        deliveryBoyName: req.user.name || 'Delivery Boy',
        totalCashReceived: totalCash,
        returnMeterReading: returnReading,
        distanceTravelled: results[0].distanceTravelled ?? null,
        message: `🏠 ${results.length} orders wapas! Cash: Rs.${totalCash}`,
      });
    }

    res.json({
      success: true,
      orders: populatedOrders,
      summary: {
        totalCashReceived: totalCash,
        totalAmount,
        change: totalCash - totalAmount,
        returnMeterReading: returnReading,
        distanceTravelled: results[0].distanceTravelled ?? null,
        ordersCompleted: results.length,
      },
      message: `🏠 Wapas aa gaye! ${results.length} orders complete. Cashier se payment verify karwaein.`,
    });
  } catch (error) {
    console.error('Complete delivery (multiple) error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = exports;