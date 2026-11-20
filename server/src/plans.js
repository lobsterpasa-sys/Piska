/**
 * Тарифы. Одна подписка Premium действует сразу во всех трёх приложениях.
 */
export const VOICE_EFFECTS = ['none', 'echo', 'robot', 'radio', 'deep', 'chipmunk'];

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    limits: {
      voiceRoomSize: 5,
      watchRoomSize: 4,
      voiceEffects: ['none', 'echo'],
      voiceBitrateKbps: 32,
      privateRooms: false,
      boostPremiumNodes: false,
      boostMultipath: false,
    },
  },
  premium: {
    id: 'premium',
    name: 'Hub Premium',
    priceMonthly: 4.99,
    limits: {
      voiceRoomSize: 20,
      watchRoomSize: 20,
      voiceEffects: VOICE_EFFECTS,
      voiceBitrateKbps: 128,
      privateRooms: true,
      boostPremiumNodes: true,
      boostMultipath: true,
    },
  },
};

export function planFor(subscription, now = Date.now()) {
  if (subscription && subscription.plan === 'premium' && (!subscription.expires_at || subscription.expires_at > now)) {
    return PLANS.premium;
  }
  return PLANS.free;
}
