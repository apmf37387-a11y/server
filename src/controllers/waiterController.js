const Order = require('../models/Order');
const Product = require('../models/Product');
const Deal = require('../models/Deal');
const Inventory = require('../models/Inventory');
const ColdDrink = require('../models/Colddrink');
const Table = require('../models/Table');
const User = require('../models/User');
const { generateOrderNumber, calculateTotalTime, calculateOrderTotal } = require('../utils/helpers');
const { getSystemSettings } = require('../utils/systemSettings');
const { deductFoodIngredientsForOrder, deductColdDrinksForOrder } = require('../utils/inventoryDeduction');

const BRANCH_NAME = 'Al Madina Fast Food Shahkot';

const FLOORS = ['ground_floor', 'first_floor', 'second_floor', 'outdoor'];
const TABLES_PER_FLOOR = 30;
const TABLE_CAPACITY = 4;

// ========== MENU ==========

exports.getMenu = async (req, res) => {
  try {
    const branchId = req.user.branchId;

    const products = await Product.find({ branchId, isAvailable: true })
      .populate('sizes.ingredients.inventoryItemId', 'name currentStock unit')
      .lean();

    const rawDeals = await Deal.find({
      branchId,
      isActive: true,
    })
      .populate('products.productId', 'name image')
      .lean();

    const deals = rawDeals.map(d => ({ ...d, price: d.discountedPrice }));

    const now = new Date();
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
      counts: { products: products.length, deals: deals.length, coldDrinks: coldDrinks.length }
    });
  } catch (error) {
    console.error('Get menu error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== GET DELIVERY BOYS ==========

exports.getDeliveryBoys = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const boys = await User.find({
      branchId,
      role: 'delivery',
      isApproved: true,
    }).select('name phone _id').lean();
    res.json({ success: true, deliveryBoys: boys });
  } catch (error) {
    console.error('Get delivery boys error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== INITIALIZE TABLES ==========

exports.initializeTables = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    let created = 0;
    let skipped = 0;

    for (const floor of FLOORS) {
      for (let tableNumber = 1; tableNumber <= TABLES_PER_FLOOR; tableNumber++) {
        const existing = await Table.findOne({ branchId, tableNumber, floor });
        if (existing) {
          skipped++;
          continue;
        }
        await Table.create({
          tableNumber,
          capacity: TABLE_CAPACITY,
          floor,
          branchId,
          isOccupied: false,
          isActive: true,
        });
        created++;
      }
    }

    res.json({
      success: true,
      message: `Tables initialized. Created: ${created}, Already existed: ${skipped}`,
      created,
      skipped,
    });
  } catch (error) {
    console.error('initializeTables error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== RESET TABLE OCCUPANCY ==========

exports.resetTableOccupancy = async (req, res) => {
  try {
    const branchId = req.user.branchId;

    const result = await Table.updateMany(
      { branchId, isOccupied: true },
      { $set: { isOccupied: false, currentOrderId: null } }
    );

    res.json({
      success: true,
      message: `${result.modifiedCount} tables reset successfully`,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error('resetTableOccupancy error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== TABLES ==========

exports.getTables = async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const { floor } = req.query;

    const query = { branchId, isActive: true };
    if (floor) query.floor = floor;

    const tables = await Table.find(query)
      .populate({
        path: 'currentOrderId',
        select: 'orderNumber total status items createdAt orderType',
        populate: { path: 'waiterId', select: 'name' }
      })
      .sort({ floor: 1, tableNumber: 1 })
      .lean();

    const groupedTables = {
      ground_floor: [],
      first_floor: [],
      second_floor: [],
      outdoor: [],
    };

    tables.forEach(table => {
      if (groupedTables[table.floor]) groupedTables[table.floor].push(table);
    });

    res.json({ success: true, tables, groupedTables, count: tables.length });
  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== CREATE ORDER ==========

exports.createOrder = async (req, res) => {
  try {
    const {
      orderType, tableNumber, floor, items,
      customerName, customerPhone, deliveryAddress,
      notes, cashierNote, deliveryBoyId,
    } = req.body;

    if (!items || items.length === 0)
      return res.status(400).json({ success: false, message: 'Order must have at least one item' });

    const branchId = req.user.branchId;

    // ── System settings check ──────────────────────────────────────────────
    const { kitchenSystemEnabled, barmanSystemEnabled } = await getSystemSettings(branchId);

    const processedItems = items.map(item => {
      let itemType = 'Product';
      if (item.type === 'cold_drink') itemType = 'Inventory';
      else if (item.type === 'deal') itemType = 'Deal';
      return {
        ...item,
        itemType: item.itemType || itemType,
        customizations: Array.isArray(item.customizations) ? item.customizations : [],
        note: item.note || null,
      };
    });

    if (orderType === 'dine_in') {
      if (!tableNumber || !floor)
        return res.status(400).json({ success: false, message: 'Table number aur floor zaroori hai' });
      if (!FLOORS.includes(floor))
        return res.status(400).json({ success: false, message: `Invalid floor: ${floor}` });
    }
    if (orderType === 'delivery') {
      if (!customerName || !customerPhone)
        return res.status(400).json({ success: false, message: 'Customer name aur phone zaroori hai' });
      if (!deliveryAddress)
        return res.status(400).json({ success: false, message: 'Delivery address zaroori hai' });
    }

    const { subtotal, tax, total } = calculateOrderTotal(processedItems, 0, 0);
    const estimatedTime = calculateTotalTime(processedItems);

    const hasColdDrinksInOrder = processedItems.some(i => i.isColdDrink || i.type === 'cold_drink');

    const initialStatus = kitchenSystemEnabled ? 'pending' : 'ready';
    const initialStockDed = !kitchenSystemEnabled;

    const coldDrinksStatus = (!hasColdDrinksInOrder || !barmanSystemEnabled)
      ? 'delivered'
      : 'pending';

    let finalCashierNote = cashierNote || '';
    if (!finalCashierNote) {
      if (orderType === 'dine_in')
        finalCashierNote = `🪑 Dine In — Table ${tableNumber} (${(floor || '').replace(/_/g, ' ')})`;
      else if (orderType === 'takeaway')
        finalCashierNote = `🥡 Takeaway — ${customerName || 'Walk-in'}${customerPhone ? ' | ' + customerPhone : ''}`;
      else if (orderType === 'delivery')
        finalCashierNote = `🚚 Delivery — ${customerName} | ${customerPhone}`;
    }

    const orderData = {
      orderNumber: await generateOrderNumber(),
      branchId,
      orderType,
      items: processedItems,
      subtotal, tax, total, estimatedTime,
      waiterId: req.user._id,
      notes,
      cashierNote: finalCashierNote,
      status: initialStatus,
      stockDeducted: initialStockDed,
      updatedByWaiter: false,
      hasColdDrinks: hasColdDrinksInOrder,
      coldDrinksStatus,
    };

    if (orderType === 'dine_in') { orderData.tableNumber = tableNumber; orderData.floor = floor; }
    if (orderType === 'takeaway' || orderType === 'delivery') {
      if (customerName) orderData.customerName = customerName;
      if (customerPhone) orderData.customerPhone = customerPhone;
    }
    if (orderType === 'delivery') {
      orderData.deliveryAddress = deliveryAddress;
      if (deliveryBoyId) orderData.deliveryBoyId = deliveryBoyId;
    }

    const order = await Order.create(orderData);

    // ── Table occupancy ────────────────────────────────────────────────────
    if (orderType === 'dine_in') {
      let table = await Table.findOne({ branchId, tableNumber, floor });
      if (!table) {
        table = await Table.create({ tableNumber, capacity: TABLE_CAPACITY, floor, branchId, isActive: true, isOccupied: false });
      }
      if (table.isOccupied) {
        await Order.findByIdAndDelete(order._id);
        return res.status(400).json({ success: false, message: `Table ${tableNumber} (${floor.replace(/_/g, ' ')}) already occupied` });
      }
      table.isOccupied = true;
      table.currentOrderId = order._id;
      await table.save();
    }

    // ── Deduct inventory when kitchen/barman system OFF ────────────────────
    if (!kitchenSystemEnabled) {
      await deductFoodIngredientsForOrder(processedItems);
    }
    if (hasColdDrinksInOrder && !barmanSystemEnabled) {
      await deductColdDrinksForOrder(processedItems);
    }

    const populatedOrder = await Order.findById(order._id)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name phone')
      .populate('items.itemId', 'name');

    const io = req.app.get('io');
    if (io) {
      if (orderType === 'delivery' && deliveryBoyId) {
        io.to(`branch-${branchId}`).emit('delivery-assigned', {
          orderId: String(order._id), orderNumber: order.orderNumber,
          customerName, deliveryAddress, total,
          deliveryBoyId: String(deliveryBoyId), assignedBy: req.user.name || 'Waiter',
        });
      }
      if (hasColdDrinksInOrder && barmanSystemEnabled) {
        io.to(`branch-${String(branchId)}`).emit('new-colddrink-order', {
          orderId: String(order._id), orderNumber: order.orderNumber,
          orderType: order.orderType, tableNumber: order.tableNumber || null,
          floor: order.floor || null, total: order.total,
          coldDrinkItems: processedItems
            .filter(i => i.isColdDrink || i.type === 'cold_drink')
            .map(i => ({ name: i.name, size: i.size || null, quantity: i.quantity })),
          message: `🧃 New cold drink order #${order.orderNumber}`,
        });
      }
      // Chef notification — sirf jab kitchen system ON ho (unchanged)
      if (kitchenSystemEnabled) {
        io.to(`branch-${String(branchId)}`).emit('new-order', {
          orderId: order._id, orderNumber: order.orderNumber,
          orderType: order.orderType, tableNumber: order.tableNumber,
          floor: order.floor, total: order.total, itemCount: processedItems.length,
        });
      }

      // ── ✅ NEW: Kitchen SLIP auto-print — HAMESHA, koi toggle check nahi ──
      // Cashier flow jaisa: silent, backend-driven, frontend pe koi UI nahi.
      io.to(`branch-${String(branchId)}`).emit('kitchen-print-request', {
        _id: String(order._id),
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        tableNumber: order.tableNumber || null,
        floor: order.floor || null,
        customerName: order.customerName || null,
        customerPhone: order.customerPhone || null,
        deliveryAddress: order.deliveryAddress || null,
        waiterName: req.user.name || 'Waiter',
        cashierNote: order.cashierNote || null,
        notes: order.notes || null,
        createdAt: order.createdAt,
        items: processedItems.map(i => ({
          name: i.name,
          quantity: i.quantity,
          size: i.size || null,
          customizations: Array.isArray(i.customizations) ? i.customizations : [],
          note: i.note || null,
        })),
      });
    }

    res.status(201).json({
      success: true,
      order: populatedOrder,
      systemInfo: { kitchenSystemEnabled, barmanSystemEnabled },
      message: 'Order successfully create ho gayi',
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== MY ORDERS ==========

exports.getMyOrders = async (req, res) => {
  try {
    const { showHistory } = req.query;

    let query;
    if (showHistory === 'true') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      query = { waiterId: req.user._id, createdAt: { $gte: sevenDaysAgo } };
    } else {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      query = { waiterId: req.user._id, createdAt: { $gte: oneDayAgo } };
    }

    const orders = await Order.find(query)
      .populate('chefId', 'name')
      .populate('deliveryBoyId', 'name phone')
      .populate('items.itemId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    console.error('Get my orders error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== UPDATE ORDER ==========

exports.updateOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const { items, notes, cashierNote } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID required hai' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order nahi mili' });
    }

    if (order.waiterId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Ye aapki order nahi' });
    }

    const EDITABLE_STATUSES = ['pending', 'preparing', 'ready', 'delivered'];
    if (!EDITABLE_STATUSES.includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `${order.status} order edit nahi ho sakti`,
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Kam se kam ek item zaroori hai' });
    }

    // ✅ NEW: purane items snapshot — sirf kitchen slip ke liye "kya naya add hua" nikalne ke liye
    const previousItemsKey = (order.items || []).map(
      i => `${String(i.itemId || '')}_${i.size || ''}_${i.name || ''}`
    );

    const processedItems = items.map(item => {
      let itemType = item.itemType;
      if (!itemType) {
        if (item.type === 'cold_drink') itemType = 'Inventory';
        else if (item.type === 'deal') itemType = 'Deal';
        else itemType = 'Product';
      }
      return {
        itemId: String(item.itemId?._id || item.itemId || ''),
        name: item.name || 'Item',
        size: item.size || null,
        quantity: Number(item.quantity) || 1,
        price: Number(item.price) || 0,
        subtotal: (Number(item.price) || 0) * (Number(item.quantity) || 1),
        type: item.type || 'product',
        itemType,
        isColdDrink: item.isColdDrink || false,
        coldDrinkId: item.coldDrinkId || null,
        coldDrinkSizeId: item.coldDrinkSizeId || null,
        customizations: Array.isArray(item.customizations) ? item.customizations : [],
        note: item.note || null,
      };
    });

    const { subtotal, tax, total } = calculateOrderTotal(processedItems, order.discount || 0, 0);

    order.items = processedItems;
    order.subtotal = subtotal;
    order.tax = tax;
    order.total = total;
    order.estimatedTime = calculateTotalTime(processedItems);

    if (notes !== undefined) order.notes = notes;
    if (cashierNote !== undefined) order.cashierNote = cashierNote;

    order.updatedByWaiter = true;
    order.waiterUpdatedAt = new Date();
    order.waiterUpdatedBy = req.user.name || 'Waiter';

    const wasReadyOrDelivered = ['ready', 'delivered'].includes(order.status);
    let statusReset = false;

    if (wasReadyOrDelivered) {
      order.status = 'preparing';
      order.stockDeducted = false;
      statusReset = true;
    }

    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('chefId', 'name')
      .populate('items.itemId', 'name');

    // ✅ NEW: sirf naye add-hone-wale items nikalo (jo purane snapshot mein nahi thay)
    const newlyAddedItems = processedItems.filter(i => {
      const key = `${i.itemId}_${i.size || ''}_${i.name}`;
      return !previousItemsKey.includes(key);
    });
    const kitchenItemsToPrint = newlyAddedItems.length > 0 ? newlyAddedItems : processedItems;

    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`branch-${String(order.branchId)}`).emit('order-updated-by-waiter', {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          tableNumber: order.tableNumber || null,
          floor: order.floor || null,
          status: order.status,
          statusReset,
          waiterName: req.user.name || 'Waiter',
          waiterUpdatedAt: order.waiterUpdatedAt,
          total: order.total,
          itemCount: order.items.length,
          items: (populatedOrder.items || []).map(i => ({
            name: i.itemId?.name || i.name || 'Item',
            size: i.size || null,
            quantity: i.quantity,
          })),
          message: statusReset
            ? `⚠️ ${req.user.name || 'Waiter'} ne ready/delivered order update ki — dobara check karein!`
            : `📝 ${req.user.name || 'Waiter'} ne order #${order.orderNumber} update kiya`,
        });

        // ── ✅ NEW: Kitchen SLIP auto-print on update — HAMESHA, silent ──
        io.to(`branch-${String(order.branchId)}`).emit('kitchen-print-request', {
          _id: String(order._id),
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          tableNumber: order.tableNumber || null,
          floor: order.floor || null,
          customerName: order.customerName || null,
          customerPhone: order.customerPhone || null,
          deliveryAddress: order.deliveryAddress || null,
          waiterName: req.user.name || 'Waiter',
          cashierNote: order.cashierNote || null,
          notes: `UPDATED ORDER${newlyAddedItems.length > 0 ? '' : ' — full items (no new item detected)'}`,
          createdAt: order.waiterUpdatedAt,
          items: kitchenItemsToPrint.map(i => ({
            name: i.name,
            quantity: i.quantity,
            size: i.size || null,
            customizations: i.customizations || [],
            note: i.note || null,
          })),
        });
      }
    } catch (socketErr) {
      console.warn('[WaiterUpdate] Socket emit failed (non-fatal):', socketErr.message);
    }

    res.json({
      success: true,
      order: populatedOrder,
      statusReset,
      message: statusReset
        ? '✅ Order update ho gayi aur chef ko dobara bhej di gayi!'
        : '✅ Changes save ho gaye. Chef ko notify kar diya gaya.',
    });
  } catch (error) {
    console.error('[updateOrder] ERROR:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== ACKNOWLEDGE ORDER UPDATE ==========

exports.acknowledgeOrderUpdate = async (req, res) => {
  try {
    const { orderId } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order nahi mili' });

    order.updatedByWaiter = false;
    await order.save();

    res.json({ success: true, message: 'Acknowledged' });
  } catch (error) {
    console.error('acknowledgeOrderUpdate error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== MARK DELIVERED ==========

exports.markDelivered = async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order nahi mili' });

    if (order.waiterId.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Ye aapki order nahi' });

    if (order.status !== 'ready')
      return res.status(400).json({ success: false, message: 'Sirf ready orders deliver ki ja sakti hain' });

    order.status = 'delivered';
    order.deliveredAt = new Date();
    await order.save();

    const populated = await Order.findById(order._id).populate('deliveryBoyId', 'name');

    try {
      const io = req.app.get('io');
      if (io)
        io.to(`branch-${String(order.branchId)}`).emit('order-updated', {
          orderId: String(order._id), newStatus: 'delivered',
        });
    } catch (e) { /* non-fatal */ }

    res.json({ success: true, order: populated, message: 'Order delivered mark ho gayi' });
  } catch (error) {
    console.error('markDelivered error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== GET ORDER SLIP ==========

exports.getOrderSlip = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('waiterId', 'name')
      .populate('cashierId', 'name')
      .populate('deliveryBoyId', 'name')
      .populate('items.itemId', 'name');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.waiterId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const slipData = {
      orderNumber: order.orderNumber,
      orderType: order.orderType,
      tableNumber: order.tableNumber,
      floor: order.floor?.replace(/_/g, ' '),
      cashierNote: order.cashierNote,
      items: order.items.map(item => ({
        name: item.itemId?.name || item.name || 'Item',
        size: item.size,
        quantity: item.quantity,
        price: item.price,
        subtotal: item.price * item.quantity,
      })),
      subtotal: order.subtotal || order.total,
      discount: order.discount || 0,
      tax: order.tax || 0,
      total: order.total,
      waiter: order.waiterId?.name || null,
      deliveryBoy: order.deliveryBoyId?.name || null,
      branchName: BRANCH_NAME,
      createdAt: order.createdAt,
      status: order.status,
    };

    res.json({ success: true, slipData });
  } catch (error) {
    console.error('Get order slip error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== DELETE ORDER (Cancel) ==========

exports.deleteOrder = async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order nahi mili' });

    if (order.waiterId.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Ye aapki order nahi' });

    if (order.status !== 'pending')
      return res.status(400).json({ success: false, message: 'Sirf pending orders cancel ho sakti hain' });

    // ✅ Setting status to 'cancelled' triggers the Order pre('save') hook
    // which automatically frees the table — no need for manual table update here.
    order.status = 'cancelled';
    await order.save();

    res.json({ success: true, message: 'Order cancel ho gayi' });
  } catch (error) {
    console.error('deleteOrder error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== REQUEST PRINT ==========

exports.requestPrint = async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId)
      .populate('waiterId', 'name')
      .populate('deliveryBoyId', 'name')
      .lean();

    if (!order) return res.status(404).json({ success: false, message: 'Order nahi mili' });

    const slipData = {
      orderNumber: order.orderNumber,
      orderType: order.orderType,
      tableNumber: order.tableNumber || null,
      floor: order.floor || null,
      customerName: order.customerName || null,
      customerPhone: order.customerPhone || null,
      deliveryAddress: order.deliveryAddress || null,
      deliveryBoy: order.deliveryBoyId?.name || null,
      waiter: order.waiterId?.name || null,
      cashierNote: order.cashierNote || null,
      items: (order.items || []).map(item => ({
        name: item.name || 'Item',
        size: item.size || null,
        quantity: item.quantity,
        price: item.price,
        subtotal: item.subtotal ?? item.price * item.quantity,
      })),
      subtotal: order.subtotal || order.total,
      discount: order.discount || 0,
      tax: order.tax || 0,
      total: order.total,
      paymentMethod: order.paymentMethod || null,
      receivedAmount: order.receivedAmount || 0,
      changeAmount: order.changeAmount || 0,
      createdAt: order.createdAt,
      paidAt: order.paidAt || null,
    };

    try {
      const io = req.app.get('io');
      if (io)
        io.to(`branch-${String(order.branchId)}`).emit('print-order', {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          slipData,
        });
    } catch (e) {
      console.warn('[requestPrint] Socket emit error (non-fatal):', e.message);
    }

    res.json({ success: true, message: 'Print request bhej di gayi' });
  } catch (error) {
    console.error('requestPrint error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = exports;