// Traditional-to-Simplified conversion for docs rendering (common characters only).
//
// Rationale: /docs renders the live OpenAPI spec, whose summaries/descriptions
// are Traditional Chinese. The site is Simplified Chinese, so the docs layer
// converts spec text to Simplified before display - without mutating the spec
// itself (other machine consumers still read it as-is). Literal substitution only.

const TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = {
  "\u5716": "\u56fe", // tu -> tu
  "\u52d9": "\u52a1", // wu -> wu
  "\u61c9": "\u5e94", // ying
  "\u5167": "\u5185", // nei
  "\u5d4c": "\u5d4c", // qian (same)
  "\u7372": "\u83b7", // huo
  "\u9810": "\u9884", // yu
  "\u8a2d": "\u8bbe", // she
  "\u50c5": "\u4ec5", // jin
  "\u53c3": "\u53c2", // can
  "\u6578": "\u6570", // shu
  "\u9ad4": "\u4f53", // ti
  "\u97ff": "\u54cd", // xiang
  "\u8f2a": "\u8f6e", // lun
  "\u8a62": "\u8be2", // xun
  "\u984d": "\u989d", // e
  "\u5ea6": "\u5ea6", // du (same)
  "\u5e63": "\u5e01", // bi
  "\u968a": "\u961f", // dui
  "\u5217": "\u5217", // lie (same)
  "\u8aa4": "\u8bef", // wu
  "\u6642": "\u65f6", // shi
  "\u9593": "\u95f4", // jian
  "\u6b0a": "\u6743", // quan
  "\u9a57": "\u9a8c", // yan
  "\u8b49": "\u8bc1", // zheng
  "\u8a8d": "\u8ba4", // ren
  "\u5e33": "\u8d26", // zhang
  "\u8cc7": "\u8d44", // zi
  "\u8a0a": "\u8baf", // xun
  "\u8996": "\u89c6", // shi
  "\u983b": "\u9891", // pin
  "\u6435": "\u643a", // xie
  "\u5e36": "\u5e26", // dai
  "\u50b3": "\u4f20", // chuan
  "\u905e": "\u9012", // di
  "\u8a3a": "\u8bca", // zhen
  "\u65b7": "\u65ad", // duan
  "\u8655": "\u5904", // chu
  "\u7406": "\u7406", // li (same)
  "\u6a5f": "\u673a", // ji
  "\u5236": "\u5236", // zhi (same)
  "\u985e": "\u7c7b", // lei
  "\u578b": "\u578b", // xing (same)
  "\u8a73": "\u8be6", // xiang
  "\u7d30": "\u7ec6", // xi
  "\u7e8c": "\u7eed", // xu
  "\u7d81": "\u7ed1", // bang
  "\u904b": "\u8fd0", // yun
  "\u7b97": "\u7b97", // suan (same)
  "\u7de9": "\u7f13", // huan
  "\u5b58": "\u5b58", // cun (same)
  "\u8abf": "\u8c03", // tiao
  "\u6b78": "\u5f52", // gui
  "\u7d50": "\u7ed3", // jie
  "\u904e": "\u8fc7", // guo
  "\u767c": "\u53d1", // fa
  "\u5e03": "\u5e03", // bu (same)
  "\u8a3b": "\u6ce8", // zhu
  "\u518a": "\u518c", // ce
  "\u90f5": "\u90ae", // you
  "\u7bb1": "\u7bb1", // xiang (same)
  "\u7de8": "\u7f16", // bian
  "\u7dad": "\u7ef4", // wei
  "\u8b77": "\u62a4", // hu
  "\u5be9": "\u5ba1", // shen
  "\u6838": "\u6838", // he (same)
  "\u8a8c": "\u5fd7", // zhi
  "\u88dc": "\u8865", // bu
  "\u512a": "\u4f18", // you
  "\u9078": "\u9009", // xuan
  "\u64c7": "\u62e9", // ze
  "\u57f7": "\u6267", // zhi
  "\u884c": "\u884c", // xing (same)
  "\u8a08": "\u8ba1", // ji
  "\u756b": "\u753b", // hua
  "\u958b": "\u5f00", // kai
  "\u555f": "\u542f", // qi
  "\u9ede": "\u70b9", // dian
  "\u64ca": "\u51fb", // ji
  "\u8f49": "\u8f6c", // zhuan
  "\u92b7": "\u9500", // xiao
  "\u7cfb": "\u7cfb", // xi (same)
  "\u7d71": "\u7edf", // tong
  "\u6236": "\u6237", // hu
  "\u6b04": "\u680f", // lan
  "\u532f": "\u6c47", // hui
  "\u6a94": "\u6863", // dang
  "\u9801": "\u9875", // ye
  "\u7dda": "\u7ebf", // xian
  "\u5c64": "\u5c42", // ceng
  "\u9032": "\u8fdb", // jin
  "\u8b80": "\u8bfb", // du
  "\u5beb": "\u5199", // xie
  "\u9019": "\u8fd9", // zhe
  "\u54ea": "\u54ea", // na (same)
  "\u9ebc": "\u4e48", // me
  "\u55ce": "\u5417", // ma
  "\u8207": "\u4e0e", // yu
  "\u65bc": "\u4e8e", // yu
  "\u5f8c": "\u540e", // hou
  "\u500b": "\u4e2a", // ge
  "\u7a2e": "\u79cd", // zhong
  "\u5f35": "\u5f20", // zhang
  "\u70ba": "\u4e3a", // wei
  "\u5340": "\u533a", // qu
  "\u5225": "\u522b", // bie
  "\u7e3d": "\u603b", // zong
  "\u8a9e": "\u8bed", // yu
  "\u7fa9": "\u4e49", // yi
  "\u96b1": "\u9690", // yin
  "\u79c1": "\u79c1", // si (same)
  "\u5c0d": "\u5bf9", // dui
  "\u6e96": "\u51c6", // zhun
  "\u78ba": "\u786e", // que
  "\u8b6f": "\u8bd1", // yi
  "\u78bc": "\u7801", // ma
  "\u7570": "\u5f02", // yi
  "\u72c0": "\u72b6", // zhuang
  "\u614b": "\u6001", // tai
  "\u64da": "\u636e", // ju
  "\u6aa2": "\u68c0", // jian
  "\u7d22": "\u7d22", // suo (same)
  "\u5c0e": "\u5bfc", // dao
  "\u89bd": "\u89c8", // lan
  "\u52d5": "\u52a8", // dong
  "\u7d42": "\u7ec8", // zhong
  "\u68c4": "\u5f03", // qi
  "\u91cb": "\u91ca", // shi
  "\u653e": "\u653e", // fang (same)
  "\u9055": "\u8fdd", // wei
  "\u898f": "\u89c4", // gui
  "\u6514": "\u62e6", // lan
  "\u622a": "\u622a", // jie (same)
  "\u6263": "\u6263", // kou (same)
  "\u8cbb": "\u8d39", // fei
  "\u9918": "\u4f59", // yu
  "\u5132": "\u50a8", // chu
  "\u7db2": "\u7f51", // wang
  "\u8def": "\u8def", // lu (same)
  "\u5354": "\u534f", // xie
  "\u8b70": "\u8bae", // yi
  "\u6a19": "\u6807", // biao
  "\u982d": "\u5934", // tou
  "\u589e": "\u589e", // zeng (same)
  "\u52a0": "\u52a0", // jia (same)
  "\u5eab": "\u5e93", // ku
  "\u6599": "\u6599", // liao (same)
  "\u7b46": "\u7b14", // bi
  "\u9304": "\u5f55", // lu
  "\u8a18": "\u8bb0", // ji
  "\u8f09": "\u8f7d", // zai
  "\u96c6": "\u96c6", // ji (same)
  "\u8acb": "\u8bf7", // qing
};

/** Convert a Traditional Chinese fragment to Simplified. Unknown characters stay as-is. */
export function toSimplified(value: string): string {
  if (!value) return value;
  let out = "";
  for (const ch of value) {
    out += TRADITIONAL_TO_SIMPLIFIED[ch] ?? ch;
  }
  return out;
}