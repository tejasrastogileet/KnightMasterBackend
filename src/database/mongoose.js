import mongoose from 'mongoose';

const connectDB = async () => {
    try {
      console.log('MONGODB_URI:', process.env.MONGODB_URI);
      
      if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not defined in environment variables');
      }
      
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('MongoDB connected successfully');
    } catch (error) {
      console.error('Database connection error:', error.message);
      process.exit(1);
    }
  };
  export default connectDB;