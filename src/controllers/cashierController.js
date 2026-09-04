// controllers/cashierController.js  — RELEVANT SECTIONS
// Only the changed/added functions shown — rest of file stays the same

const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const Deal = require('../models/Deal');
const Table = require('../models/Table');
const Inventory = require('../models/Inventory');
const Expense = require('../models/Expense'); // ✅ NEW
const { PaymentStatus } = require('../config/constants');
const { generateOrderNumber, calculateTotalTime, calculateOrderTotal } = require('../utils/helpers');
const { getSystemSettings } = require('../utils/systemSettings');
const { deductFoodIngredientsForOrder, deductColdDrinksForOrder } = require('../utils/inventoryDeduction');


const BRANCH_NAME = 'Al Madina Fast Food Shahkot';

// ========== INVENTORY DEDUCTION HELPER ==========

function getSessionWindow() {
  const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5

  const nowUTC = new Date();
  // nowPKT: UTC time ko PKT mein convert karo (getUTCHours() use hoga)
  const nowPKT = new Date(nowUTC.getTime() + PKT_OFFSET_MS);
  const hourPKT = nowPKT.getUTCHours(); // PKT ka actual hour

  // Session start: 9 AM PKT
  const sessionStartPKT = new Date(nowPKT);
  if (hourPKT < 9) {
    // Abhi 9 AM PKT se pehle hai — session kal shuru hua tha
    sessionStartPKT.setUTCDate(sessionStartPKT.getUTCDate() - 1);
  }
  sessionStartPKT.setUTCHours(9, 0, 0, 0);

  // Session end: next day 4 AM PKT
  const sessionEndPKT = new Date(sessionStartPKT);
  sessionEndPKT.setUTCDate(sessionEndPKT.getUTCDate() + 1);
  sessionEndPKT.setUTCHours(4, 0, 0, 0);

  // MongoDB queries ke liye UTC mein wapas convert karo
  const sessionStart = new Date(sessionStartPKT.getTime() - PKT_OFFSET_MS);
  const sessionEnd = new Date(sessionEndPKT.getTime() - PKT_OFFSET_MS);

  return { sessionStart, sessionEnd };
}

const deductInventoryForOrder = async (order) => {
  try {
    for (const item of order.items) {
      let product = await Product.findById(item.itemId)
        .populate('sizes.ingredients.inventoryItemId');

      if (product) {
        const sizeData = product.sizes.find(
          s => s.size.toLowerCase() === (item.size || 'medium').toLowerCase()
        );
        if (sizeData && sizeData.ingredients && sizeData.ingredients.length > 0) {
          for (const ingredient of sizeData.ingredients) {
            const deductQty = ingredient.quantity * (item.quantity || 1);
            await Inventory.findByIdAndUpdate(
              ingredient.inventoryItemId._id || ingredient.inventoryItemId,
              { $inc: { currentStock: -deductQty } }
            );
          }
        }
      }

      const deal = await Deal.findById(item.itemId).populate({
        path: 'products.productId',
        populate: { path: 'sizes.ingredients.inventoryItemId' }
      });

      if (deal) {
        for (const dealProduct of deal.products) {
          const prod = dealProduct.productId;
          if (!prod) continue;
          const sizeData = prod.sizes.find(
            s => s.size.toLowerCase() === (dealProduct.size || 'medium').toLowerCase()
          );
          if (sizeData && sizeData.ingredients) {
            for (const ingredient of sizeData.ingredients) {
              const deductQty = ingredient.quantity * (dealProduct.quantity || 1) * (item.quantity || 1);
              await Inventory.findByIdAndUpdate(
                ingredient.inventoryItemId._id || ingredient.inventoryItemId,
                { $inc: { currentStock: -deductQty } }
              );
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Inventory deduction error (non-fatal):', error);
  }
};

exports.deductInventoryForOrder = deductInventoryForOrder;

// ========== ORDERS ==========

exports.getPendingOrders = async (req, res) => {
  try {
    const branchId = req.user.branchId;

    const orders = await Order.find({
      branchId,
      status: {
        $in: [
          'pending',
          'accepted',
          'preparing',
          'ready',
          'out_for_delivery',
          'delivered',
          'returned',
        ],
      },
    })
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('chefId', 'name')
      // ✅ ADDED: barmanId populate so cashier knows who delivered cold drinks
      .populate('barmanId', 'name')
      .populate('items.itemId')
      .sort({ createdAt: 1 });

    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    console.error('Get pending orders error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ UPDATED: getCompletedOrders now supports last24hours, date range, and date+time range
exports.getCompletedOrders = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const {
      startDate,
      endDate,
      startDateTime,
      endDateTime,
      last24hours,
      mySession,     // ✅ NEW param
    } = req.query;

    let query = { branchId, status: 'completed' };

    // ── ✅ mySession: only this cashier's orders, 9AM–4AM window ────────
    if (mySession === 'true') {
      query.cashierId = req.user._id;
      const { sessionStart, sessionEnd } = getSessionWindow();
      query.completedAt = { $gte: sessionStart, $lte: sessionEnd };

      // ── Existing: precise datetime range ────────────────────────────────
    } else if (startDateTime && endDateTime) {
      query.completedAt = {
        $gte: new Date(startDateTime),
        $lte: new Date(endDateTime),
      };

      // ── Existing: date-only range ────────────────────────────────────────
    } else if (startDate && endDate) {
      query.completedAt = {
        $gte: new Date(startDate),
        $lte: new Date(new Date(endDate).setHours(23, 59, 59)),
      };
    } else if (startDate && !endDate) {
      query.completedAt = { $gte: new Date(startDate) };

      // ── Existing: last 24 hours (default fallback) ───────────────────────
    } else if (last24hours === 'true') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      query.completedAt = { $gte: since };

      // ── Existing: no params → last 24 hours ─────────────────────────────
    } else {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      query.completedAt = { $gte: since };
    }

    const orders = await Order.find(query)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('chefId', 'name')
      .populate('cashierId', 'name')
      .populate('items.itemId')
      .sort({ completedAt: -1 })
      .limit(500);

    // ── Return session window info when in mySession mode ────────────────
    let sessionMeta = null;
    if (mySession === 'true') {
      const { sessionStart, sessionEnd } = getSessionWindow();
      sessionMeta = {
        start: sessionStart.toISOString(),
        end: sessionEnd.toISOString(),
      };
    }

    res.json({
      success: true,
      orders,
      count: orders.length,
      sessionMeta,   // null unless mySession=true
    });
  } catch (error) {
    console.error('Get completed orders error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ NEW: Get single order by ID
exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('chefId', 'name')
      .populate('cashierId', 'name')
      .populate('items.itemId');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (String(order.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error('Get order by ID error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== ADVANCE PAYMENT ==========

exports.receiveAdvancePayment = async (req, res) => {
  try {
    const orderId = req.params.id;
    const { amount, method = 'cash', transactionId, notes } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    const order = await Order.findById(orderId)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Order already completed hai' });
    }

    const prevAdvance = Number(order.advancePaid || 0);
    const orderTotal = Number(order.total || 0);
    const newAdvance = prevAdvance + Number(amount);
    const cappedAdvance = Math.min(newAdvance, orderTotal);

    order.advancePaid = cappedAdvance;
    order.advancePaymentMethod = method;
    order.paymentStatus = cappedAdvance >= orderTotal ? 'fully_advance' : 'partial_advance';
    await order.save();

    await Payment.create({
      orderId: order._id,
      branchId: req.user.branchId,
      amount: Number(amount),
      method,
      status: 'partial',
      cashierId: req.user._id,
      waiterId: order.waiterId,
      deliveryBoyId: order.deliveryBoyId,
      receivedAmount: Number(amount),
      changeAmount: 0,
      transactionId: transactionId || '',
      notes: notes || 'Advance payment',
      paidAt: new Date(),
    });

    const remaining = orderTotal - cappedAdvance;

    res.json({
      success: true,
      order,
      advancePaid: cappedAdvance,
      remaining,
      isFullyPaid: cappedAdvance >= orderTotal,
      message: cappedAdvance >= orderTotal
        ? `✅ Full advance paid! Order complete hone pe sirf slip print hogi.`
        : `✅ Advance Rs.${Number(amount).toLocaleString()} record. Remaining: Rs.${remaining.toLocaleString()}`,
    });
  } catch (error) {
    console.error('Receive advance payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== COMPLETE ADVANCE-PAID ORDER ==========

exports.completeAdvancePaidOrder = async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const advance = Number(order.advancePaid || 0);
    const total = Number(order.total || 0);

    if (advance < total) {
      return res.status(400).json({
        success: false,
        message: `Order fully paid nahi hai. Remaining: Rs.${(total - advance).toLocaleString()}`,
      });
    }

    const payment = await Payment.create({
      orderId: order._id,
      branchId: req.user.branchId,
      amount: total,
      method: order.advancePaymentMethod || 'cash',
      status: PaymentStatus.PAID,
      cashierId: req.user._id,
      waiterId: order.waiterId,
      deliveryBoyId: order.deliveryBoyId,
      receivedAmount: advance,
      changeAmount: Math.max(0, advance - total),
      notes: 'Advance paid — order completed',
      paidAt: new Date(),
    });

    order.status = 'completed';
    order.completedAt = new Date();
    order.cashierId = req.user._id;
    await order.save();

    if (order.tableNumber) {
      await Table.findOneAndUpdate(
        { branchId: req.user.branchId, tableNumber: order.tableNumber },
        { isOccupied: false, currentOrderId: null }
      );
    }

    const populatedPayment = await Payment.findById(payment._id)
      .populate('cashierId', 'name')
      .populate('waiterId', 'name')
      .populate('orderId');

    res.json({
      success: true,
      payment: populatedPayment,
      order,
      slipData: buildSlipData(order, populatedPayment),
      message: 'Order completed successfully',
    });
  } catch (error) {
    console.error('Complete advance paid order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== PAYMENT ==========

exports.receivePayment = async (req, res) => {
  try {
    const { orderId, amount, method, receivedAmount, transactionId, notes } = req.body;

    const order = await Order.findById(orderId)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId');

    if (!order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    // ── Cold drinks check — only if barman system is ON ───────────────────
    const { barmanSystemEnabled } = await getSystemSettings(order.branchId);
    if (barmanSystemEnabled && order.hasColdDrinks && order.coldDrinksStatus !== 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'Cold drinks abhi barman ne deliver nahi ki hain.',
        coldDrinksStatus: order.coldDrinksStatus,
        hasColdDrinks: true,
      });
    }

    const advance = Number(order.advancePaid || 0);
    const orderTotal = Number(order.total || 0);
    const remainingAmount = Math.max(0, orderTotal - advance);
    const finalAmount = amount !== undefined ? Number(amount) : remainingAmount;
    const finalReceived = receivedAmount || order.cashReceived || finalAmount;
    const changeAmount = Math.max(0, Number(finalReceived) - remainingAmount);

    const payment = await Payment.create({
      orderId, branchId: req.user.branchId,
      amount: finalAmount, method,
      status: PaymentStatus.PAID,
      cashierId: req.user._id,
      waiterId: order.waiterId,
      deliveryBoyId: order.deliveryBoyId,
      receivedAmount: finalReceived,
      changeAmount, transactionId, notes,
      paidAt: new Date(),
    });

    order.status = 'completed';
    order.completedAt = new Date();
    order.cashierId = req.user._id;
    await order.save();

    if (order.tableNumber) {
      await Table.findOneAndUpdate(
        { branchId: req.user.branchId, tableNumber: order.tableNumber },
        { isOccupied: false, currentOrderId: null }
      );
    }

    const populatedPayment = await Payment.findById(payment._id)
      .populate('cashierId', 'name')
      .populate('waiterId', 'name')
      .populate('orderId');

    res.json({
      success: true,
      payment: populatedPayment,
      order,
      slipData: buildSlipData(order, populatedPayment),
      message: 'Payment received successfully',
    });
  } catch (error) {
    console.error('Receive payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== PAYMENT SLIP ==========

const buildSlipData = (order, payment) => ({
  orderNumber: order.orderNumber,
  orderType: order.orderType,
  tableNumber: order.tableNumber,
  customerName: order.customerName || null,
  customerPhone: order.customerPhone || null,
  deliveryAddress: order.deliveryAddress || null,
  deliveryBoy: payment.deliveryBoyId?.name || null,
  distanceTravelled: order.distanceTravelled || null,
  startMeterReading: order.startMeterReading || null,
  endMeterReading: order.endMeterReading || null,
  items: order.items.map(item => ({
    name: item.itemId?.name || item.name || 'Item',
    size: item.size,
    quantity: item.quantity,
    price: item.price,
    subtotal: item.price * item.quantity,
  })),
  subtotal: order.subtotal || order.total,
  discount: order.discount || 0,
  total: order.total,
  advancePaid: order.advancePaid || 0,
  paymentMethod: payment.method,
  receivedAmount: payment.receivedAmount,
  changeAmount: payment.changeAmount,
  cashier: payment.cashierId?.name || 'Cashier',
  waiter: payment.waiterId?.name || null,
  paidAt: payment.paidAt,
  branchName: BRANCH_NAME,
});

exports.getPaymentSlip = async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('cashierId', 'name')
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate({
        path: 'orderId',
        populate: [
          { path: 'items.itemId' },
          { path: 'branchId', select: 'name address phone' },
        ],
      });

    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });

    const order = payment.orderId;
    const slipData = buildSlipData(order, payment);

    res.json({ success: true, slipData });
  } catch (error) {
    console.error('Get payment slip error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPaymentHistory = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { startDate, endDate } = req.query;

    let query = { branchId };
    if (startDate && endDate) {
      query.paidAt = {
        $gte: new Date(startDate),
        $lte: new Date(new Date(endDate).setHours(23, 59, 59)),
      };
    }

    const payments = await Payment.find(query)
      .populate('orderId', 'orderNumber total orderType')
      .populate('cashierId', 'name')
      .populate('waiterId', 'name')
      .sort({ paidAt: -1 })
      .limit(100);

    const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);

    res.json({ success: true, payments, summary: { totalPayments: payments.length, totalAmount } });
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== HOURLY INCOME REPORT ==========

exports.getHourlyIncomeReport = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { date } = req.query;

    const reportDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(reportDate); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(reportDate); endOfDay.setHours(23, 59, 59, 999);

    const payments = await Payment.find({
      branchId,
      paidAt: { $gte: startOfDay, $lte: endOfDay },
      status: 'paid',
    }).populate('orderId', 'orderType orderNumber');

    const hourlyData = {};
    for (let h = 0; h < 24; h++) {
      hourlyData[h] = {
        hour: h,
        label: `${h.toString().padStart(2, '0')}:00 - ${(h + 1).toString().padStart(2, '0')}:00`,
        totalAmount: 0, orderCount: 0, cash: 0, mezan_bank: 0, online: 0,
      };
    }

    let totalRevenue = 0, cashTotal = 0, mezan_bankTotal = 0, onlineTotal = 0;

    payments.forEach(payment => {
      const hour = new Date(payment.paidAt).getHours();
      const amt = Number(payment.amount || 0);
      const change = Number(payment.changeAmount || 0);

      hourlyData[hour].totalAmount += amt;
      hourlyData[hour].orderCount += 1;
      totalRevenue += amt;

      if (payment.method === 'cash') {
        hourlyData[hour].cash += amt;
        cashTotal += amt;
      } else {
        const accountReceived = amt + change; // ✅ full account amount
        hourlyData[hour].cash -= change;      // ✅ return cash se cut
        cashTotal -= change;

        if (payment.method === 'mezan_bank') { hourlyData[hour].mezan_bank += accountReceived; mezan_bankTotal += accountReceived; }
        else if (payment.method === 'online') { hourlyData[hour].online += accountReceived; onlineTotal += accountReceived; }
      }
    });

    const hourlyArray = Object.values(hourlyData).filter(h => h.totalAmount > 0 || h.orderCount > 0);
    const summary = {
      totalRevenue,
      totalOrders: payments.length,
      cashTotal,
      mezan_bankTotal,
      onlineTotal,
      peakHour: hourlyArray.length > 0
        ? hourlyArray.reduce((max, h) => h.totalAmount > max.totalAmount ? h : max, hourlyArray[0])
        : null,
    };

    res.json({ success: true, date: reportDate.toISOString().split('T')[0], hourlyData: hourlyArray, summary });
  } catch (error) {
    console.error('Hourly income report error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== ✅ NEW: CASHIER SHIFT SLIP REPORT ==========
// Returns all payments + expenses for a given date+time range
// Frontend (Electron) uses this to build the POS-58 cashier slip
exports.getCashierShiftReport = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { startDateTime, endDateTime } = req.query;

    if (!startDateTime || !endDateTime) {
      return res.status(400).json({
        success: false,
        message: 'startDateTime aur endDateTime zaroori hain',
      });
    }

    // ✅ FIX: If datetime string has timezone info (+05:00), parse directly.
    // If NOT (naive string like "2026-04-23T09:00:00"), treat as PKT and convert to UTC.
    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

    function parsePKT(dtStr) {
      // Has timezone offset (+05:00, Z, etc.)? Parse as-is.
      if (dtStr.includes('+') || dtStr.endsWith('Z')) {
        return new Date(dtStr);
      }
      // Naive string → treat as PKT → subtract 5h to get UTC
      return new Date(new Date(dtStr).getTime() - PKT_OFFSET_MS);
    }

    const start = parsePKT(startDateTime);
    const end = parsePKT(endDateTime);

    // ── Payments in range ──
    const payments = await Payment.find({
      branchId,
      paidAt: { $gte: start, $lte: end },
      status: 'paid',
    })
      .populate('cashierId', 'name')
      .populate('orderId', 'orderNumber orderType');

    // ── Expenses in range ──
    const expenses = await Expense.find({
      branchId,
      $or: [
        { createdAt: { $gte: start, $lte: end } },
        { date: { $gte: start, $lte: end } },
      ],
    }).populate('addedBy', 'name');

    // ── Revenue summary ──
    // ✅ har payment ka asal account-received amount aur cash-return calculate
    let cashReceived = 0, mezan_bankReceived = 0, onlineReceived = 0, jazzReceived = 0, easyReceived = 0;
    let totalRevenue = 0;
    const returns = []; // ✅ "Return" entries report/slip ke liye

    payments.forEach(p => {
      const amt = Number(p.amount || 0);
      const change = Number(p.changeAmount || 0);
      totalRevenue += amt;

      if (p.method === 'cash') {
        cashReceived += amt;
      } else {
        const accountReceived = amt + change; // ✅ us account mein asal jitna aaya
        cashReceived -= change;                // ✅ return cash se cut

        if (p.method === 'mezan_bank') mezan_bankReceived += accountReceived;
        else if (p.method === 'online') onlineReceived += accountReceived;
        else if (p.method === 'jazz_cash') jazzReceived += accountReceived;
        else if (p.method === 'easypaisa') easyReceived += accountReceived;

        if (change > 0) {
          returns.push({
            orderNumber: p.orderId?.orderNumber || '-',
            method: p.method,
            returnAmount: change,
            paidAt: p.paidAt,
          });
        }
      }
    });

    const totalReturns = returns.reduce((s, r) => s + r.returnAmount, 0);

    // ── Expense summary ── ✅ yehi missing ho gaya tha
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

    const expensesByMethod = {};
    expenses.forEach(e => {
      const method = e.paymentMethod || 'cash';
      expensesByMethod[method] = (expensesByMethod[method] || 0) + e.amount;
    });

    const netAmount = totalRevenue - totalExpenses;

    res.json({
      success: true,
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
        // ✅ Human-readable PKT times for debugging
        startPKT: new Date(start.getTime() + PKT_OFFSET_MS).toISOString().replace('T', ' ').substring(0, 16),
        endPKT: new Date(end.getTime() + PKT_OFFSET_MS).toISOString().replace('T', ' ').substring(0, 16),
      },
      payments,
      expenses,
      returns,          // ✅ NEW
      summary: {
        totalOrders: payments.length,
        totalRevenue,
        cashReceived,
        mezan_bankReceived,
        onlineReceived,
        jazzReceived,
        easyReceived,
        totalReturns,   // ✅ NEW
        totalExpenses,
        expensesByMethod,
        netAmount,
      },
    });
  } catch (error) {
    console.error('Cashier shift report error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== ORDER STATUS UPDATE ==========

exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id).populate('items.itemId');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const previousStatus = order.status;
    order.status = status;

    if (status === 'accepted' && previousStatus === 'pending') {
      await deductInventoryForOrder(order);
    }

    await order.save();
    res.json({ success: true, order, message: `Order status updated to ${status}` });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== PRODUCTS ==========

exports.createProduct = async (req, res) => {
  try {
    const productData = { ...req.body, branchId: req.user.branchId, createdBy: req.user._id };
    const product = await Product.create(productData);
    const populatedProduct = await Product.findById(product._id)
      .populate('branchId', 'name')
      .populate('createdBy', 'name')
      .populate('sizes.ingredients.inventoryItemId', 'name currentStock unit');
    res.status(201).json({ success: true, product: populatedProduct, message: 'Product created successfully' });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true })
      .populate('branchId', 'name')
      .populate('createdBy', 'name')
      .populate('sizes.ingredients.inventoryItemId', 'name currentStock unit');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product, message: 'Product updated successfully' });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getProducts = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const products = await Product.find({ branchId })
      .populate('branchId', 'name')
      .populate('createdBy', 'name')
      .populate('sizes.ingredients.inventoryItemId', 'name currentStock unit')
      .sort({ createdAt: -1 });
    res.json({ success: true, products, count: products.length });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== DEALS ==========

exports.createDeal = async (req, res) => {
  try {
    const { products, ...rest } = req.body;
    const cleanedProducts = (products || []).map(item => {
      const cleaned = { itemType: item.itemType || 'product', size: item.size, quantity: parseInt(item.quantity) || 1 };
      if (item.itemType === 'cold_drink') { if (item.coldDrinkId) cleaned.coldDrinkId = item.coldDrinkId; }
      else { if (item.productId) cleaned.productId = item.productId; }
      return cleaned;
    });
    const deal = await Deal.create({ ...rest, products: cleanedProducts, branchId: req.user.branchId, createdBy: req.user._id });
    const populatedDeal = await Deal.findById(deal._id)
      .populate('branchId', 'name').populate('createdBy', 'name').populate('products.productId', 'name image');
    res.status(201).json({ success: true, deal: populatedDeal, message: 'Deal created successfully' });
  } catch (error) {
    console.error('Create deal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateDeal = async (req, res) => {
  try {
    const { products, ...rest } = req.body;
    const cleanedProducts = (products || []).map(item => {
      const cleaned = { itemType: item.itemType || 'product', size: item.size, quantity: parseInt(item.quantity) || 1 };
      if (item.itemType === 'cold_drink') { if (item.coldDrinkId) cleaned.coldDrinkId = item.coldDrinkId; }
      else { if (item.productId) cleaned.productId = item.productId; }
      return cleaned;
    });
    const deal = await Deal.findByIdAndUpdate(req.params.id, { ...rest, products: cleanedProducts }, { new: true })
      .populate('branchId', 'name').populate('createdBy', 'name').populate('products.productId', 'name image');
    if (!deal) return res.status(404).json({ success: false, message: 'Deal not found' });
    res.json({ success: true, deal, message: 'Deal updated successfully' });
  } catch (error) {
    console.error('Update deal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDeals = async (req, res) => {
  try {
    const deals = await Deal.find({ branchId: req.user.branchId })
      .populate('branchId', 'name').populate('createdBy', 'name').populate('products.productId', 'name image')
      .sort({ createdAt: -1 });
    res.json({ success: true, deals, count: deals.length });
  } catch (error) {
    console.error('Get deals error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== TABLES ==========

exports.getTables = async (req, res) => {
  try {
    const tables = await Table.find({ branchId: req.user.branchId })
      .populate({ path: 'currentOrderId', select: 'orderNumber total status items', populate: { path: 'waiterId', select: 'name' } })
      .sort({ tableNumber: 1 });
    res.json({ success: true, tables, count: tables.length });
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createTable = async (req, res) => {
  try {
    const { tableNumber, capacity } = req.body;
    const existingTable = await Table.findOne({ branchId: req.user.branchId, tableNumber });
    if (existingTable) return res.status(400).json({ success: false, message: 'Table number already exists' });
    const table = await Table.create({ tableNumber, capacity, branchId: req.user.branchId, isOccupied: false, isActive: true });
    res.status(201).json({ success: true, table, message: 'Table created successfully' });
  } catch (error) {
    console.error('Create table error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateTable = async (req, res) => {
  try {
    const table = await Table.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!table) return res.status(404).json({ success: false, message: 'Table not found' });
    res.json({ success: true, table, message: 'Table updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteTable = async (req, res) => {
  try {
    const table = await Table.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!table) return res.status(404).json({ success: false, message: 'Table not found' });
    res.json({ success: true, message: 'Table deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.seedTables = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const floors = ['ground_floor', 'first_floor', 'second_floor', 'outdoor'];
    const TABLES_PER_FLOOR = 30;
    let created = 0, skipped = 0;

    for (const floor of floors) {
      for (let tableNum = 1; tableNum <= TABLES_PER_FLOOR; tableNum++) {
        const existing = await Table.findOne({ branchId, tableNumber: tableNum, floor });
        if (!existing) { await Table.create({ tableNumber: tableNum, capacity: 4, floor, branchId, isActive: true, isOccupied: false }); created++; }
        else { skipped++; }
      }
    }

    res.json({ success: true, message: `Tables seeded! Created: ${created}, Already existed: ${skipped}`, total: floors.length * TABLES_PER_FLOOR, created, skipped });
  } catch (error) {
    console.error('Seed tables error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getColdDrinks = async (req, res) => {
  try {
    const coldDrinks = await Inventory.find({ branchId: req.user.branchId, category: 'cold_drinks', isActive: true }).sort({ name: 1 });
    res.json({ success: true, coldDrinks, count: coldDrinks.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createOrder = async (req, res) => {
  try {
    const {
      orderType, tableNumber, floor, customerName, customerPhone,
      deliveryAddress, cashierNote, notes, discount = 0, items = [],
    } = req.body;
 
    if (!items || items.length === 0)
      return res.status(400).json({ success: false, message: 'Items required' });
 
    const branchId = req.user.branchId;
 
    // ── System settings ────────────────────────────────────────────────────
    const { kitchenSystemEnabled, barmanSystemEnabled } = await getSystemSettings(branchId);
 
    let subtotal = 0;
    const processedItems = [];
 
    for (const item of items) {
      const itemSubtotal = item.subtotal != null
        ? Number(item.subtotal)
        : Number(item.price || 0) * Number(item.quantity || 1);
      subtotal += itemSubtotal;
      processedItems.push({
        itemId: item.itemId,
        itemType: item.itemType || 'Product',
        type: item.type || 'product',
        name: item.name || 'Item',
        size: item.size || null,
        note: item.note || null,
        quantity: Number(item.quantity) || 1,
        price: Number(item.price) || 0,
        subtotal: itemSubtotal,
        preparationTime: item.preparationTime || 0,
        isColdDrink: item.isColdDrink || false,
        coldDrinkId: item.coldDrinkId || null,
        coldDrinkSizeId: item.coldDrinkSizeId || null,
      });
    }
 
    const discountAmt = Math.min(Number(discount) || 0, subtotal);
    const total = subtotal - discountAmt;
    const orderNumber = await generateOrderNumber();
 
    const hasColdDrinksInOrder = processedItems.some(
      i => i.isColdDrink || i.type === 'cold_drink'
    );
 
    // ── Initial states based on system settings ────────────────────────────
    const initialStatus = kitchenSystemEnabled ? 'pending' : 'ready';
    const initialStockDed = !kitchenSystemEnabled;
    const coldDrinksStatus = (!hasColdDrinksInOrder || !barmanSystemEnabled)
      ? 'delivered'
      : 'pending';
 
    const order = await Order.create({
      orderNumber, branchId,
      orderType: orderType || 'dine_in',
      tableNumber: tableNumber || null,
      floor: floor || null,
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      deliveryAddress: deliveryAddress || null,
      cashierNote: cashierNote || '',
      notes: notes || '',
      items: processedItems,
      subtotal, discount: discountAmt, total, tax: 0,
      status: initialStatus,
      stockDeducted: initialStockDed,
      cashierId: req.user._id,
      hasColdDrinks: hasColdDrinksInOrder,
      coldDrinksStatus,
    });
 
    // ── ✅ FIX 1: Table update + populate ek sath parallel (independent calls) ──
    const tableUpdatePromise = (orderType === 'dine_in' && tableNumber && floor)
      ? Table.findOneAndUpdate(
          { branchId, tableNumber, floor },
          { isOccupied: true, currentOrderId: order._id }
        )
      : Promise.resolve(null);
 
    const populatedOrderPromise = Order.findById(order._id)
      .populate('cashierId', 'name')
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId');
 
    const [, populatedOrder] = await Promise.all([tableUpdatePromise, populatedOrderPromise]);
 
    // ── ✅ FIX 2: Response PEHLE bhej do — user ko turant confirmation mile ──
    const io = req.app.get('io');
    if (io) {
      if (kitchenSystemEnabled) {
        io.to(String(branchId)).emit('new-order', {
          orderId: order._id, orderNumber: order.orderNumber,
          orderType: order.orderType, tableNumber: order.tableNumber,
          floor: order.floor, total: order.total, itemCount: processedItems.length,
        });
      }
      if (hasColdDrinksInOrder && barmanSystemEnabled) {
        io.to(String(branchId)).emit('new-colddrink-order', {
          orderId: String(order._id), orderNumber: order.orderNumber,
          orderType: order.orderType, tableNumber: order.tableNumber || null,
          floor: order.floor || null, total: order.total,
          coldDrinkItems: processedItems
            .filter(i => i.isColdDrink || i.type === 'cold_drink')
            .map(i => ({ name: i.name, size: i.size, quantity: i.quantity })),
          message: `🧃 New cold drink order #${order.orderNumber}`,
        });
      }
    }
 
    res.status(201).json({
      success: true,
      order: populatedOrder,
      systemInfo: { kitchenSystemEnabled, barmanSystemEnabled },
      message: `Order #${orderNumber} created successfully`,
    });
 
    // ── ✅ FIX 3: Inventory deduction RESPONSE KE BAAD, background mein ──────
    //    User ko wait nahi karna — agar deduction fail bhi ho to order create
    //    ho chuka hai, sirf stock thoda late update hoga (jo cosmetic hai).
    if (!kitchenSystemEnabled) {
      deductFoodIngredientsForOrder(processedItems).catch(err => {
        console.error(`Background food deduction failed for order ${orderNumber}:`, err);
      });
    }
    if (hasColdDrinksInOrder && !barmanSystemEnabled) {
      deductColdDrinksForOrder(processedItems).catch(err => {
        console.error(`Background cold drink deduction failed for order ${orderNumber}:`, err);
      });
    }
  } catch (error) {
    console.error('Create order error:', error);
    // ✅ Agar response already bhej diya hai (deduction wale catch block mein
    //    error aaye), to dobara res.json mat karo — warna "headers already sent" crash hoga
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

exports.getAmountSummary = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { sessionStart, sessionEnd } = getSessionWindow();

    const payments = await Payment.find({
      branchId,
      paidAt: { $gte: sessionStart, $lte: sessionEnd },
      status: 'paid',
    })
      .populate('orderId', 'orderNumber orderType')
      .sort({ paidAt: -1 });

    // ✅ NEW: account-wise correct totals
    //    - Cash method: amount as-is (uska apna change cash mein hi wapas jata hai, self-cancel)
    //    - Non-cash method: amount + changeAmount = us account mein asal mein jitna aaya
    //      aur wo changeAmount cash se minus (kyunke customer ko cash mein wapas diya gaya)
    let cashTotal = 0, mezan_bankTotal = 0, onlineTotal = 0, jazz_cashTotal = 0, easypaisaTotal = 0;
    let totalRevenue = 0;
    const returns = []; // ✅ NEW: return entries — report mein "Return" k naam se dikhengi

    payments.forEach(p => {
      const amt = Number(p.amount || 0);
      const change = Number(p.changeAmount || 0);
      totalRevenue += amt; // business revenue hamesha order-value pe based (780), overpayment nahi

      if (p.method === 'cash') {
        cashTotal += amt;
      } else {
        const accountReceived = amt + change; // ✅ us account ka asal amount
        cashTotal -= change; // ✅ return cash se cut

        if (p.method === 'mezan_bank') mezan_bankTotal += accountReceived;
        else if (p.method === 'online') onlineTotal += accountReceived;
        else if (p.method === 'jazz_cash') jazz_cashTotal += accountReceived;
        else if (p.method === 'easypaisa') easypaisaTotal += accountReceived;

        if (change > 0) {
          returns.push({
            orderNumber: p.orderId?.orderNumber || '-',
            method: p.method,
            returnAmount: change,
            paidAt: p.paidAt,
          });
        }
      }
    });

    const summary = {
      totalRevenue,
      totalTransactions: payments.length,
      cashTotal,
      mezan_bankTotal,
      onlineTotal,
      jazz_cashTotal,
      easypaisaTotal,
      totalReturns: returns.reduce((s, r) => s + r.returnAmount, 0), // ✅ NEW
    };

    res.json({
      success: true,
      period: {
        start: sessionStart.toISOString(),
        end: sessionEnd.toISOString(),
      },
      summary,
      returns, // ✅ NEW — "Return" list report mein
      recentPayments: payments.slice(0, 10),
    });
  } catch (error) {
    console.error('Amount summary error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
//asad

exports.addMissedOrderPayment = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { orderId, orderNumber, amount, method, notes } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId zaroori hai' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount zaroori hai' });
    }

    // ✅ FIXED: ORD- format aur MongoDB _id dono support
    let order;
    if (typeof orderId === 'string' && orderId.trim().toUpperCase().startsWith('ORD-')) {
      order = await Order.findOne({ orderNumber: orderId.trim(), branchId: req.user.branchId });
    } else {
      order = await Order.findOne({ _id: orderId, branchId: req.user.branchId });
    }

    // ✅ FIXED: null check jo pehle missing tha
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order nahi mili — Order ID ya Order Number dobara check karein',
      });
    }

    const payment = await Payment.create({
      orderId: order._id,   // ✅ FIXED: string ki jagah real ObjectId
      branchId,
      amount: Number(amount),
      method: method || 'cash',
      status: 'paid',
      cashierId: req.user._id,
      receivedAmount: Number(amount),
      changeAmount: 0,
      notes: notes || `Missed payment manually added for ${order.orderNumber}`,
      paidAt: new Date(),
    });

    const populated = await Payment.findById(payment._id)
      .populate('cashierId', 'name')
      .populate('orderId', 'orderNumber total orderType');

    res.json({
      success: true,
      payment: populated,
      message: `✅ Missed payment Rs.${Number(amount).toLocaleString()} added for ${order.orderNumber}`,
    });
  } catch (error) {
    console.error('Add missed payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addManualPayment = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { description, amount, method, receivedFrom, transactionId, notes } = req.body;

    if (!description?.trim()) {
      return res.status(400).json({ success: false, message: 'Description zaroori hai' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount zaroori hai' });
    }

    const payment = await Payment.create({
      // orderId intentionally omitted (make it optional in schema)
      branchId,
      amount: Number(amount),
      method: method || 'cash',
      status: 'paid',
      cashierId: req.user._id,
      receivedAmount: Number(amount),
      changeAmount: 0,
      transactionId: transactionId || '',
      notes: [
        description,
        receivedFrom ? `From: ${receivedFrom}` : '',
        notes || '',
      ].filter(Boolean).join(' | '),
      isManual: true,   // flag for UI distinction
      paidAt: new Date(),
    });

    const populated = await Payment.findById(payment._id)
      .populate('cashierId', 'name');

    res.json({
      success: true,
      payment: populated,
      message: `✅ Manual payment Rs.${Number(amount).toLocaleString()} add ho gayi`,
    });
  } catch (error) {
    console.error('Manual payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.replaceOrderPayment = async (req, res) => {
  try {
    const { orderId, newMethod, transactionId, notes } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId zaroori hai' });
    }
    if (!newMethod) {
      return res.status(400).json({ success: false, message: 'newMethod zaroori hai' });
    }

    const validMethods = ['cash', 'mezan_bank', 'online', 'jazz_cash', 'easypaisa'];
    if (!validMethods.includes(newMethod)) {
      return res.status(400).json({
        success: false,
        message: `Invalid method. Valid: ${validMethods.join(', ')}`,
      });
    }

    // ✅ FIXED: ORD- format aur MongoDB _id dono support
    let order;
    if (typeof orderId === 'string' && orderId.trim().toUpperCase().startsWith('ORD-')) {
      order = await Order.findOne({ orderNumber: orderId.trim(), branchId: req.user.branchId });
    } else {
      order = await Order.findOne({ _id: orderId, branchId: req.user.branchId });
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order nahi mili ya unauthorized — Order ID ya Order Number check karein',
      });
    }

    // Most recent paid payment for this order
    const payment = await Payment.findOne({
      orderId: order._id,   // ✅ FIXED: real ObjectId use
      branchId: req.user.branchId,
      status: 'paid',
    }).sort({ paidAt: -1 });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Is order ki koi paid payment nahi mili',
      });
    }

    const oldMethod = payment.method;

    if (oldMethod === newMethod) {
      return res.status(400).json({
        success: false,
        message: `Method already ${newMethod} hai — change karna zaroori nahi`,
      });
    }

    payment.method = newMethod;
    if (transactionId) payment.transactionId = transactionId;
    if (notes) payment.notes = (payment.notes ? payment.notes + ' | ' : '') + notes;
    payment.updatedAt = new Date();
    await payment.save();

    const populated = await Payment.findById(payment._id)
      .populate('cashierId', 'name')
      .populate('orderId', 'orderNumber total orderType');

    res.json({
      success: true,
      payment: populated,
      oldMethod,
      newMethod,
      message: `✅ Payment method replace ho gaya: ${oldMethod} → ${newMethod}`,
    });
  } catch (error) {
    console.error('Replace order payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateActiveOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const { itemsToAdd = [], itemsToUpdate = [] } = req.body; // ✅ FIX: itemsToUpdate destructure kiya

    if ((!itemsToAdd || itemsToAdd.length === 0) && (!itemsToUpdate || itemsToUpdate.length === 0))
      return res.status(400).json({ success: false, message: 'Koi item add ya update nahi kiya gaya' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (String(order.branchId) !== String(req.user.branchId))
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (order.status === 'completed' || order.status === 'cancelled')
      return res.status(400).json({ success: false, message: `Order already ${order.status} hai` });

    // System settings fetch
    const { kitchenSystemEnabled, barmanSystemEnabled } = await getSystemSettings(req.user.branchId);

    // ✅ FIX: existing items ki quantity update karo (frontend +/- se aati hai)
    for (const upd of itemsToUpdate) {
      const idx = Number(upd.itemIndex);
      if (Number.isInteger(idx) && order.items[idx]) {
        const item = order.items[idx];
        const newQty = Number(upd.quantity) || item.quantity;
        item.quantity = newQty;
        item.subtotal = (item.price || 0) * newQty;
      }
    }

    // Existing items add loop — jaisa pehle tha
    for (const newItem of itemsToAdd) {
      const itemSubtotal = newItem.subtotal != null
        ? Number(newItem.subtotal)
        : Number(newItem.price || 0) * Number(newItem.quantity || 1);

      const existingIdx = order.items.findIndex(
        i => i.name === newItem.name &&
          (i.size || null) === (newItem.size || null) &&
          (i.note || null) === (newItem.note || null)
      );

      if (existingIdx >= 0) {
        const existing = order.items[existingIdx];
        existing.quantity = (existing.quantity || 1) + Number(newItem.quantity || 1);
        existing.subtotal = (existing.price || 0) * existing.quantity;
      } else {
        order.items.push({
          itemId: newItem.itemId || null,
          itemType: newItem.itemType || 'Product',
          type: newItem.type || 'product',
          name: newItem.name || 'Item',
          size: newItem.size || null,
          note: newItem.note || null,
          customizations: newItem.customizations || [],
          quantity: Number(newItem.quantity) || 1,
          price: Number(newItem.price) || 0,
          subtotal: itemSubtotal,
          isColdDrink: newItem.isColdDrink || false,
          coldDrinkId: newItem.coldDrinkId || null,
          coldDrinkSizeId: newItem.coldDrinkSizeId || null,
        });
      }

      if (newItem.isColdDrink || newItem.type === 'cold_drink') {
        order.hasColdDrinks = true;
        if (barmanSystemEnabled) order.coldDrinksStatus = 'pending';
      }
    }

    const newSubtotal = order.items.reduce((s, i) => s + (i.subtotal || 0), 0);
    order.subtotal = newSubtotal;
    order.total = newSubtotal - (order.discount || 0);

    // Kitchen OFF ho to updatedByWaiter flag mat lagao — chef ko notify nahi
    if (kitchenSystemEnabled) {
      order.updatedByWaiter = true;
      order.updatedByCashier = true;
      order.waiterUpdatedAt = new Date();
      order.waiterUpdatedBy = req.user.name || 'Cashier';
    }

    const wasReadyOrDelivered = ['ready', 'delivered'].includes(order.status);
    // Kitchen OFF ho to status reset mat karo
    if (kitchenSystemEnabled && wasReadyOrDelivered) {
      order.status = 'preparing';
      order.stockDeducted = false;
    }

    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('cashierId', 'name')
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId');

    const io = req.app.get('io');
    if (io) {
      // Sirf kitchen ON ho tab chef ko emit karo
      if (kitchenSystemEnabled) {
        io.to(String(req.user.branchId)).emit('order-updated', {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          message: `Order #${order.orderNumber} updated by cashier`,
          addedCount: itemsToAdd.length,
        });

        io.to(String(req.user.branchId)).emit('order-updated-by-waiter', {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          tableNumber: order.tableNumber || null,
          floor: order.floor || null,
          status: order.status,
          statusReset: wasReadyOrDelivered,
          waiterName: req.user.name || 'Cashier',
          waiterUpdatedAt: order.waiterUpdatedAt,
          total: order.total,
          itemCount: order.items.length,
          updatedByCashier: true,
          message: wasReadyOrDelivered
            ? `⚠️ Cashier ne ready order update ki — dobara check karein!`
            : `📝 Cashier ne order #${order.orderNumber} update kiya`,
        });
      }

      const hasColdDrinkAdditions = itemsToAdd.some(i => i.isColdDrink || i.type === 'cold_drink');
      if (hasColdDrinkAdditions && barmanSystemEnabled) {
        io.to(String(req.user.branchId)).emit('new-colddrink-order', {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          message: `🧃 Updated cold drink order #${order.orderNumber}`,
        });
      }
    }

    res.json({
      success: true,
      order: populatedOrder,
      kitchenSystemEnabled,
      barmanSystemEnabled,
      message: `✅ Order #${order.orderNumber} update ho gaya — ${itemsToAdd.length} naya, ${itemsToUpdate.length} qty change hue`,
    });
  } catch (error) {
    console.error('Update active order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.payDeliveryBoyFuel = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const {
      deliveryBoyId,
      deliveryBoyName,
      totalKm,        // sirf display/meta ke liye
      amount,         // ✅ direct amount — no km calculation
      note,
    } = req.body;

    if (!deliveryBoyId) {
      return res.status(400).json({ success: false, message: 'deliveryBoyId zaroori hai' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount zaroori hai' });
    }

    const description = note
      || `Payment — ${deliveryBoyName || 'Delivery Boy'} | ${totalKm || 0} km`;

    const expense = await Expense.create({
      branchId,
      title: `💸 Payment: ${deliveryBoyName || 'Delivery Boy'}`,
      amount: Number(amount),
      category: 'transport',
      paymentMethod: 'cash',
      paidTo: deliveryBoyName || 'Delivery Boy',
      description,
      date: new Date(),
      addedBy: req.user._id,
      meta: {
        isFuelExpense: true,
        deliveryBoyId,
        deliveryBoyName,
        totalKm: Number(totalKm || 0),
        manualAmount: Number(amount),
      },
    });

    res.json({
      success: true,
      expense,
      message: `✅ Rs.${Number(amount).toLocaleString()} payment add ho gaya — ${deliveryBoyName}`,
    });
  } catch (error) {
    console.error('Pay delivery boy fuel error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCashierSystemInfo = async (req, res) => {
  try {
    const { getSystemSettings } = require('../utils/systemSettings');
    const settings = await getSystemSettings(req.user.branchId);
    res.json({ success: true, ...settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = exports;