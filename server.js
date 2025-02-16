const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Models
const Order = require('./models/Order');
const Product = require('./models/Product');

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://4dfb-197-232-62-186.ngrok-free.app'],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('📦 Connected to MongoDB');
    seedProducts();
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Seed initial products with reduced prices for testing
async function seedProducts() {
  try {
    // First, delete existing products
    await Product.deleteMany({});
    
    // Create new products with reduced prices
    await Product.create([
      { name: "Laptop", price: 1, description: "High-performance laptop (Test Price)" },
      { name: "Phone", price: 1, description: "Latest smartphone (Test Price)" }
    ]);
    console.log('🎉 Sample products seeded successfully with test prices');
  } catch (err) {
    console.error('❌ Seeding error:', err);
  }
}

// Daraja Authentication
async function getAccessToken() {
  try {
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { 
        headers: { 
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json'
        } 
      }
    );
    
    console.log('🔑 Successfully obtained access token');
    return response.data.access_token;
  } catch (err) {
    console.error('❌ Authentication error:', {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status
    });
    throw new Error('Failed to authenticate with Safaricom');
  }
}

// Helper function to validate and format phone number
function formatPhoneNumber(phone) {
  // Remove any non-digit characters
  const cleaned = phone.replace(/\D/g, '');
  
  // Remove leading 0 or 254
  const base = cleaned.replace(/^0|^254/, '');
  
  // Check if the remaining number is valid (9 digits)
  if (!/^\d{9}$/.test(base)) {
    throw new Error('Invalid phone number format. Please use format 07XXXXXXXX');
  }
  
  return `254${base}`;
}

// API Endpoints
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().lean();
    res.json(products);
  } catch (err) {
    console.error('❌ Product fetch error:', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    
    // Validate inputs
    if (!phone || !amount) {
      throw new Error('Phone number and amount are required');
    }
    
    // Modified minimum amount check for testing
    if (amount < 1) {
      throw new Error('Amount must be at least 1 KSH');
    }

    // Format phone number for M-Pesa
    const formattedPhone = formatPhoneNumber(phone);
    
    // Get access token
    const accessToken = await getAccessToken();
    
    // Generate timestamp
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    
    // Generate password
    const password = Buffer.from(
      `${process.env.BUSINESS_SHORTCODE}${process.env.PASSKEY}${timestamp}`
    ).toString('base64');

    // Initiate STK Push
    const { data } = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.BUSINESS_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: process.env.BUSINESS_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: process.env.CALLBACK_URL,
        AccountReference: 'HassanStore',
        TransactionDesc: 'Payment for goods'
      },
      { 
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        } 
      }
    );

    console.log('✅ STK push initiated:', {
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID,
      phone: formattedPhone,
      amount
    });

    // Create order record with additional fields
    const order = await Order.create({
      phone: formattedPhone,
      amount,
      status: 'pending',
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID,
      createdAt: new Date(),
      metadata: {
        timestamp,
        businessShortCode: process.env.BUSINESS_SHORTCODE
      }
    });

    // Verify order was created
    const verifyOrder = await Order.findById(order._id);
    console.log('📝 Order created and verified:', {
      orderId: verifyOrder._id,
      checkoutRequestId: verifyOrder.checkoutRequestId,
      status: verifyOrder.status,
      phone: verifyOrder.phone
    });

    res.json({
      success: true,
      message: 'Payment request sent. Please check your phone.',
      data: {
        ...data,
        orderId: order._id
      }
    });

  } catch (err) {
    console.error('❌ Checkout error:', {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status
    });
    
    res.status(400).json({
      success: false,
      error: err.message || 'Payment initiation failed'
    });
  }
});

// M-Pesa Callback Handler
app.post('/callback', async (req, res) => {
  try {
    const callback = req.body.Body.stkCallback;
    console.log('🔔 Received callback for checkoutRequestId:', callback.CheckoutRequestID);

    // First, try to find the order
    const existingOrder = await Order.findOne({ checkoutRequestId: callback.CheckoutRequestID });
    console.log('🔍 Order lookup result:', {
      found: !!existingOrder,
      checkoutRequestId: callback.CheckoutRequestID,
      orderId: existingOrder?._id,
      orderStatus: existingOrder?.status
    });

    const metadata = callback.CallbackMetadata?.Item || [];
    
    if (callback.ResultCode === 0) {
      const amount = metadata.find(i => i.Name === 'Amount')?.Value;
      const mpesaReceiptNumber = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const phoneNumber = metadata.find(i => i.Name === 'PhoneNumber')?.Value;

      // Update order status with more specific query
      const updatedOrder = await Order.findOneAndUpdate(
        { 
          checkoutRequestId: callback.CheckoutRequestID,
          status: 'pending' // Add status check
        },
        { 
          status: 'completed',
          mpesaCode: mpesaReceiptNumber,
          completedAt: new Date(),
          'metadata.callbackReceived': true,
          'metadata.rawCallback': JSON.stringify(req.body)
        },
        { 
          new: true,
          runValidators: true
        }
      );

      console.log('✅ Payment completed:', {
        phone: phoneNumber,
        receipt: mpesaReceiptNumber,
        amount,
        orderId: updatedOrder?._id || 'Order not found',
        checkoutRequestId: callback.CheckoutRequestID,
        orderFound: !!updatedOrder
      });

      if (!updatedOrder) {
        console.warn('⚠️ Order not found for checkout request:', {
          checkoutRequestId: callback.CheckoutRequestID,
          searchResult: await Order.findOne({ checkoutRequestId: callback.CheckoutRequestID }).lean()
        });
      }
    } else {
      // Update order status to failed with more details
      const failedOrder = await Order.findOneAndUpdate(
        { 
          checkoutRequestId: callback.CheckoutRequestID 
        },
        { 
          status: 'failed',
          failureReason: callback.ResultDesc,
          updatedAt: new Date(),
          'metadata.callbackReceived': true,
          'metadata.rawCallback': JSON.stringify(req.body),
          'metadata.failureCode': callback.ResultCode
        },
        { 
          new: true,
          runValidators: true
        }
      );

      console.warn('❌ Payment failed:', {
        code: callback.ResultCode,
        description: callback.ResultDesc,
        orderId: failedOrder?._id || 'Order not found',
        checkoutRequestId: callback.CheckoutRequestID,
        orderFound: !!failedOrder
      });
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Callback processing error:', {
      error: err.message,
      stack: err.stack,
      checkoutRequestId: req.body?.Body?.stkCallback?.CheckoutRequestID
    });
    res.status(200).json({ received: true });
  }
});

// Debug endpoint to check order by checkoutRequestId
app.get('/api/debug/order/:checkoutRequestId', async (req, res) => {
  try {
    const order = await Order.findOne({ 
      checkoutRequestId: req.params.checkoutRequestId 
    }).lean();
    
    res.json({
      found: !!order,
      order,
      checkoutRequestId: req.params.checkoutRequestId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check payment status
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).lean();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
  } catch (err) {
    console.error('❌ Order fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch order status' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));