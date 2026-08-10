import { useEffect, useState } from "react";

const mobileNavigationMediaQuery = "(max-width: 1023px)";

export function useMobileNavigationLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileNavigationMediaQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(mobileNavigationMediaQuery);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}
