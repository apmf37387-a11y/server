// models/Order.js
const mongoose = require('mongoose');
const { OrderStatus, OrderType } = require('../config/constants');

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  orderType: { type: String, enum: Object.values(OrderType), required: true },
  tableNumber: { type: Number, default: null },

  floor: {
    type: String,
    enum: ['ground_floor', 'first_floor', 'second_floor', 'outdoor', null],
    default: null,
  },

  items: [{
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'items.itemType' },
    itemType: { type: String, enum: ['Product', 'Deal', 'Inventory'], required: true },
    type: { type: String, enum: ['product', 'deal', 'cold_drink'], required: true },
    name: { type: String, required: true },
    size: { type: String },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    subtotal: { type: Number, default: 0 },
    preparationTime: { type: Number, default: 0 },
    note: { type: String, default: null },           // ✅ ADD
    customizations: [{ type: String }], 
    // Cold drink extra fields
    isColdDrink: { type: Boolean, default: false },
    coldDrinkId: { type: mongoose.Schema.Types.ObjectId, default: null },
    coldDrinkSizeId: { type: mongoose.Schema.Types.ObjectId, default: null },
  }],

  subtotal: { type: Number, required: true },
  tax: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  total: { type: Number, required: true },

  // ✅ FIX: status enum now uses Object.values(OrderStatus) which includes 'returned' and 'out_for_delivery'
  status: {
    type: String,
    enum: Object.values(OrderStatus),
    default: OrderStatus.PENDING,
  },

  waiterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  chefId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  deliveryBoyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cashierId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  barmanId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  hasColdDrinks: { type: Boolean, default: false },
  coldDrinksStatus: { type: String, enum: ['pending', 'delivered'], default: 'pending' },
  coldDrinksDeliveredAt: { type: Date, default: null },

  customerName: { type: String, default: null },
  customerPhone: { type: String, default: null },
  deliveryAddress: { type: String, default: null },

  cashierNote: { type: String, default: '' },

  estimatedTime: { type: Number },
  actualTime: { type: Number },
  additionalDelay: { type: Number, default: 0 },

  notes: { type: String },

  // Waiter update tracking
  updatedByWaiter: { type: Boolean, default: false },
  updatedByCashier: { type: Boolean, default: false },
  waiterUpdatedAt: { type: Date, default: null },
  waiterUpdatedBy: { type: String, default: null },


  // Stock deduction tracking
  stockDeducted: { type: Boolean, default: false },

  // ── Delivery Meter Tracking ────────────────────────────────────────────────
  deliveryTripId: { type: String, default: null, index: true },
  startMeterReading: { type: Number },
  endMeterReading: { type: Number },
  distanceTravelled: { type: Number },
  cashReceived: { type: Number },

  // ✅ NEW: Meter photos (base64 or URI string — optional, captured from bike meter)
  startMeterReading: { type: Number, default: null },
  endMeterReading: { type: Number, default: null },
  distanceTravelled: { type: Number, default: null },
  cashReceived: { type: Number, default: null },

  departureMeterReading: { type: Number, default: null },
  returnMeterReading: { type: Number, default: null },


  startMeterImage: { type: String, default: null },
  endMeterImage: { type: String, default: null },
  // Payment tracking
  paymentMethod: { type: String, default: null },
  receivedAmount: { type: Number, default: 0 },
  changeAmount: { type: Number, default: 0 },
  paidAt: { type: Date, default: null },

  // Advance payment tracking
  advancePaid: { type: Number, default: 0 },
  advancePaymentMethod: { type: String, default: 'cash' },
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'partial_advance', 'fully_advance'],
    default: 'unpaid',
  },

  // Timestamps
  acceptedAt: { type: Date },
  preparingAt: { type: Date },
  readyAt: { type: Date },
  departedAt: { type: Date },
  deliveredAt: { type: Date },
  returnedAt: { type: Date },  // ✅ NEW: when delivery boy returns
  completedAt: { type: Date },
}, { timestamps: true });

// ============================================================
// ✅ AUTO FREE TABLE — runs whenever status changes to
//    'completed' OR 'cancelled' for a dine_in order.
// ============================================================
orderSchema.pre('save', async function (next) {
  if (!this.isModified('status')) return next();

  const shouldFreeTable =
    (this.status === 'completed' || this.status === 'cancelled') &&
    this.orderType === 'dine_in' &&
    this.tableNumber != null &&
    this.floor != null;

  if (shouldFreeTable) {
    try {
      const Table = mongoose.model('Table');
      const result = await Table.findOneAndUpdate(
        { branchId: this.branchId, tableNumber: this.tableNumber, floor: this.floor },
        { $set: { isOccupied: false, currentOrderId: null } },
        { new: true }
      );
      if (result) {
        console.log(`✅ [Order Hook] Table ${this.tableNumber} (${this.floor}) freed — order #${this.orderNumber} → ${this.status}`);
      } else {
        console.warn(`⚠️ [Order Hook] Table ${this.tableNumber} (${this.floor}) not found`);
      }
    } catch (err) {
      console.error('❌ [Order Hook] Table free error (non-fatal):', err.message);
    }
  }

  next();
});

module.exports = mongoose.model('Order', orderSchema);