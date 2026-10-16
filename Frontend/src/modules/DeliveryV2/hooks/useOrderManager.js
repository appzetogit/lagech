import { useDeliveryStore } from '@/modules/DeliveryV2/store/useDeliveryStore';
import { resolveCustomerAddress } from '@/modules/DeliveryV2/utils/orderAddress';
import { deliveryAPI } from '@food/api';
import { toast } from 'sonner';

/**
 * Canonical id for API calls: always the Mongo _id when available.
 * Display ids (FOD-xxxx) are NOT guaranteed unique — accepting by them
 * can match a different order with the same display id on the backend.
 */
const canonicalOrderId = (order) =>
  order?.orderMongoId || order?._id || order?.orderId || order?.id || null;

/**
 * useOrderManager - Professional hook for real-world trip lifecycle actions.
 * Connects directly to the backend API services.
 */
/**
 * Whether the rider must enter the customer's handover code for this order
 * (Business Settings > Order > Delivery OTP, fixed per order at pickup).
 * Unknown means yes, as before the switch existed: with it off the server
 * accepts any code, so asking is never a dead end.
 */
export const needsHandoverOtp = (order) => {
  const flag = order?.deliveryVerification?.dropOtp?.required ?? order?.dropOtpRequired;
  return flag !== false;
};

export const useOrderManager = () => {
  const {
    activeOrder, tripStatus, updateTripStatus, clearActiveOrder, setActiveOrder, riderLocation
  } = useDeliveryStore();

  const acceptOrder = async (order) => {
    const orderId = canonicalOrderId(order);
    if (!orderId) {
      toast.error('Invalid order data');
      return;
    }

    try {
      const response = await deliveryAPI.acceptOrder(orderId);
      
      if (response?.data?.success) {
        const fullOrder = response.data.data?.order || order;
        
        // Robustly determine locations from multiple possible formats (Populated API vs Socket)
        const getLoc = (ref, keysLat, keysLng) => {
          if (!ref) return null;
          // Handle nested populated objects
          if (ref.location) {
            // Handle GeoJSON format: location: { type: 'Point', coordinates: [lng, lat] }
            if (Array.isArray(ref.location.coordinates) && ref.location.coordinates.length >= 2) {
              return {
                lat: ref.location.coordinates[1], // Latitude is second in GeoJSON [lng, lat]
                lng: ref.location.coordinates[0]  // Longitude is first
              };
            }
            // Handle standard object format: location: { latitude: 12.3, longitude: 45.6 }
            return {
              lat: ref.location.latitude || ref.location.lat,
              lng: ref.location.longitude || ref.location.lng
            };
          }
          // Handle flat objects or direct lat/lng keys
          for (const k of keysLat) { if (ref[k] != null) return { lat: ref[k], lng: ref[keysLng[keysLat.indexOf(k)]] }; }
          return null;
        };

        console.log('[OrderManager] Raw Full Order Data:', fullOrder);

        const resLoc = getLoc(fullOrder.restaurantId, ['latitude', 'lat'], ['longitude', 'lng']) || 
                       getLoc(fullOrder, ['restaurant_lat', 'restaurantLat', 'latitude'], ['restaurant_lng', 'restaurantLng', 'longitude']);
                       
        const cusLoc = getLoc(fullOrder.deliveryAddress, ['latitude', 'lat'], ['longitude', 'lng']) || 
                       getLoc(fullOrder, ['customer_lat', 'customerLat', 'latitude'], ['customer_lng', 'customerLng', 'longitude']);

        console.log('[OrderManager] Locations Mapped Result:', { resLoc, cusLoc });

        const customerAddress =
          resolveCustomerAddress(fullOrder) || resolveCustomerAddress(order);

        setActiveOrder({
          ...fullOrder,
          // Canonical Mongo id for every subsequent API call
          orderMongoId: fullOrder.orderMongoId || fullOrder._id || orderId,
          // Pretty id kept for display only (order reference, pickup confirmation)
          orderId: fullOrder.order_id || fullOrder.orderId || order?.orderId || orderId,
          displayOrderId: fullOrder.order_id || fullOrder.orderId || order?.orderId || null,
          restaurantLocation: resLoc,
          customerLocation: cusLoc,
          customerAddress,
          // Preserve trip road distance from the new-order offer payload
          tripDistanceKm:
            fullOrder.tripDistanceKm ??
            fullOrder.pricing?.roadDistanceKm ??
            order?.tripDistanceKm ??
            order?.pricing?.roadDistanceKm ??
            order?.distanceKm ??
            fullOrder.pricing?.distanceKm,
          tripDurationMins:
            fullOrder.tripDurationMins ??
            fullOrder.pricing?.roadDurationMins ??
            order?.tripDurationMins ??
            order?.pricing?.roadDurationMins,
        });

        updateTripStatus('PICKING_UP');
        // toast.success('Order Accepted! Opening Map...');
      } else {
        toast.error(response?.data?.message || 'Order already taken or unavailable');
        throw new Error('Accept failed');
      }
    } catch (error) {
      console.error('Accept Order Error:', error);
      const message =
        error?.response?.data?.message ||
        error?.message ||
        'Network error. Please try again.';
      toast.error(message);
      throw error;
    }
  };

  /**
   * Mark "Reached Pickup" (Arrival at restaurant)
   */
  const reachPickup = async () => {
    const orderId = canonicalOrderId(activeOrder);
    try {
      const response = await deliveryAPI.confirmReachedPickup(orderId);
      if (response?.data?.success) {
        updateTripStatus('REACHED_PICKUP');
        // toast.info('Arrived at Restaurant');
      } else {
        throw new Error('Confirm pickup failed');
      }
    } catch (error) {
      toast.error('Failed to update status');
      throw error;
    }
  };

  /**
   * Mark "Picked Up" (Confirm order ID & start delivery)
   */
  const pickUpOrder = async (billImageUrl) => {
    const orderId = canonicalOrderId(activeOrder);
    try {
      // confirmOrderId(orderId, confirmedOrderId, location, data)
      const response = await deliveryAPI.confirmOrderId(
        orderId,
        activeOrder.displayOrderId || activeOrder.orderId || orderId,
        riderLocation || {},
        { billImageUrl }
      );
      
      if (response?.data?.success) {
        updateTripStatus('PICKED_UP');
        // toast.success('Order Collected! Heading to Drop-off');
      } else {
        throw new Error('Confirm order ID failed');
      }
    } catch (error) {
      toast.error('Error confirming pickup');
      throw error;
    }
  };

  /**
   * Mark "Reached Drop" (Arrival at customer)
   */
  const reachDrop = async () => {
    const orderId = canonicalOrderId(activeOrder);
    try {
      const response = await deliveryAPI.confirmReachedDrop(orderId);
      if (response?.data?.success) {
        // Keep the server's word on whether this order needs the customer's code.
        const fresh = response.data?.data?.order || response.data?.data;
        if (fresh?.deliveryVerification || fresh?.dropOtpRequired !== undefined) {
          setActiveOrder({
            ...activeOrder,
            deliveryVerification: fresh.deliveryVerification ?? activeOrder?.deliveryVerification,
            dropOtpRequired: fresh.dropOtpRequired ?? activeOrder?.dropOtpRequired,
          });
        }
        updateTripStatus('REACHED_DROP');
        // toast.info('Arrived at Customer Location');
      } else {
        throw new Error('Confirm drop failed');
      }
    } catch (error) {
      toast.error('Failed to notify arrival');
      throw error;
    }
  };

  /**
   * Finalize Delivery, checking the customer's code when the order needs one
   * (Business Settings > Order > Delivery OTP).
   */
  const completeDelivery = async (otp) => {
    const orderId = canonicalOrderId(activeOrder);
    const needsOtp = needsHandoverOtp(activeOrder);
    try {
      // 1. Verify OTP first, when this order has one
      const verifyRes = needsOtp ? await deliveryAPI.verifyDropOtp(orderId, otp) : { data: { success: true } };
      
      if (verifyRes?.data?.success) {
        let finalOrder = verifyRes.data?.data?.order || activeOrder;
        
        // 2. Mark as complete
        const completeRes = await deliveryAPI.completeDelivery(orderId, needsOtp ? { otp, rating: 5 } : { rating: 5 });
        if (completeRes.data?.success && completeRes.data?.data?.order) {
          finalOrder = completeRes.data.data.order;
        } else {
          toast.error(completeRes.data?.message || 'Failed to complete delivery on server');
          throw new Error('Complete call failed');
        }
        
        // Update local order state so Summary Modal shows 'delivered' status
        if (finalOrder) setActiveOrder(finalOrder);
        
        updateTripStatus('COMPLETED');
        // toast.success('Delivery Success!');
      } else {
        toast.error('Invalid OTP. Please check with customer.');
        throw new Error('Invalid OTP');
      }
    } catch (error) {
      console.error('Completion Error:', error);
      toast.error(error?.response?.data?.message || 'Verification failed');
      throw error;
    }
  };

  const resetTrip = () => {
    clearActiveOrder();
  };

  return {
    acceptOrder,
    reachPickup,
    pickUpOrder,
    reachDrop,
    completeDelivery,
    needsHandoverOtp,
    resetTrip,
  };
};
