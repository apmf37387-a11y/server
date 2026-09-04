const express = require('express');
const router  = express.Router();
const { protect }    = require('../middlewares/auth');
const { checkRole }  = require('../middlewares/roleCheck');
const { UserRole }   = require('../config/constants');
const {
  getMenu,
  createDeliveryOrder,
  getMyOrders,
  getUnassignedOrders,
  claimOrder,
  updateOrderStatus,
  completeDelivery,
  requestPrint,        // ✅ NEW
  updateOrder,
  getDeliveryHistory,
  markDeliveredTakeaway,
  extractMeterReading,
  claimMultipleOrders,
  updateOrderStatusMultiple,
  completeDeliveryMultiple,
} = require('../controllers/deliveryController');
 
router.use(protect);
router.use(checkRole(UserRole.DELIVERY));
 
router.get('/menu',                          getMenu);
router.post('/orders',                       createDeliveryOrder);
router.get('/orders/my-orders',              getMyOrders);
router.put('/orders/:id/mark-delivered',     markDeliveredTakeaway);
router.get('/orders/unassigned',             getUnassignedOrders);   // specific before /:id
router.get('/orders/history',                getDeliveryHistory);    // specific before /:id
router.put('/orders/claim',                  claimOrder);
router.put('/orders/status',                 updateOrderStatus);
router.put('/orders/complete',               completeDelivery);
 
// ✅ Multi-order (trip) routes — YEH `/orders/:id` SE UPAR HONA ZAROORI HAI.
// Express routes ko top-se-bottom match karta hai — agar yeh `/orders/:id`
// ke baad hote to Express "claim-multiple" ko `:id` samajh kar updateOrder
// function chala deta (ObjectId cast crash). Isi wajah se error dobara aaya tha.
router.put('/orders/claim-multiple',         claimMultipleOrders);
router.put('/orders/status-multiple',        updateOrderStatusMultiple);
router.put('/orders/complete-multiple',      completeDeliveryMultiple);
 
router.post('/orders/:id/print-request',     requestPrint);          // ✅ NEW — same as waiter
router.put('/orders/:id',                    updateOrder);           // ⚠️ catch-all — hamesha SABSE NEECHE rahe
router.post('/extract-meter-reading',        extractMeterReading);
 
module.exports = router;

///zdaJHY9i8At00Bta
//zdaJHY9i8At00Bta
//mongodb+srv://granasahib379_db_user:<db_password>@cluster0.otfqs7z.mongodb.net/?appName=Cluster0